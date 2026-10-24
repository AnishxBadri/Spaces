import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  entityAlias,
  integration,
  interaction,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { renderMessage } from '@spaces/sdk/testing'
import { QUEUES } from '@spaces/core/queue/names'
import { logSyncedEmailProgram } from '#/lib/arrival/synced'
import { recordTimelineProgram } from '#/lib/timeline/record'
import { enqueued } from '#/test/queue-stub'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { setAiRouteProgram } from './route'
import { setEntitySensitiveProgram } from './sensitivity-for'
import {
  summarizeEmailBackfillProgram,
  summarizeEmailProgram,
} from './summarize-email'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * An email's summary and categories through an injected model: the
 * mail lane, the routes, the live sensitivity read and the meta write are
 * real; nothing reaches a network. What a reader sees is read off the
 * record timeline, the Interactions tab's loader.
 */

const HOUR = 3_600_000
const OWNER = FIXTURE_ACTOR
const TEAMMATE = {
  id: 'member-teammate',
  name: 'Priya',
  email: 'priya@spaces.test',
  emailVerified: true,
}
const SUMMARY = 'Sends the Q3 numbers and asks for a call on Thursday.'
let gmail = ''

/** Answers both lanes and counts its calls: text for synthesize, JSON for classify. */
function mockModel() {
  const calls: Array<string> = []
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: (options) => {
      const prompt = JSON.stringify(options.prompt)
      const labelling = prompt.includes('Label the email')
      calls.push(labelling ? 'classify' : 'synthesize')
      return Promise.resolve({
        content: [
          {
            type: 'text',
            text: labelling
              ? JSON.stringify({ categories: ['update', 'gossip'] })
              : `  ${SUMMARY}\n`,
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 100,
            noCache: 100,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      })
    },
  })
  return { model, calls }
}

async function route(
  sensitivity: 'normal' | 'sensitive',
  provider: 'anthropic' | 'ollama',
) {
  for (const lane of ['synthesize', 'classify'] as const)
    await Effect.runPromise(
      setAiRouteProgram({ lane, sensitivity, provider, model: 'some-model' }),
    )
}

beforeEach(async () => {
  await truncateAndReseed()
  enqueued.length = 0
  await db.insert(user).values(TEAMMATE)
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId: OWNER.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: 'anish@fund.example',
        tokensEnc: Buffer.from('never read'),
        scopes: ['openid', 'email', 'gmail.readonly'],
        createdAt: new Date(Date.now() - HOUR),
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!connection) throw new Error('no connection')
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'gmail',
        version: '0.1.0',
        enabled: true,
        connectionId: connection.id,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  gmail = row.id
})

/** A synced email from Acme carrying Gmail's snippet; its id and Acme's. */
async function syncEmail(subject = 'Acme — Q3 update') {
  const messageId = `${randomUUID()}@acme.io`
  const raw = renderMessage({
    id: `m-${randomUUID().slice(0, 8)}`,
    labelIds: ['INBOX'],
    receivedAt: Date.now() - 10 * 60_000,
    messageId,
    from: 'Jane Founder <jane@acme.io>',
    to: ['anish@fund.example'],
    cc: [],
    subject,
    body: 'Q3 revenue is up 40%. Could we talk Thursday?',
    attachments: [],
  })
  const result = await Effect.runPromise(
    logSyncedEmailProgram(
      { integrationId: gmail },
      {
        providerMessageId: messageId,
        raw: Buffer.from(raw),
        receivedAt: new Date(),
        labels: ['Inbox'],
        snippet: 'Q3 revenue is up 40%. Could we talk',
      },
    ),
  )
  if (result.outcome !== 'created') throw new Error(result.outcome)
  const acme = (
    await db
      .select({ id: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, 'domain'),
          eq(entityAlias.valueNorm, 'acme.io'),
        ),
      )
  ).at(0)?.id
  if (acme === undefined) throw new Error('no Acme')
  return { id: result.interactionId, acme }
}

const metaOf = async (id: string) =>
  (
    await db
      .select({ meta: interaction.meta })
      .from(interaction)
      .where(eq(interaction.id, id))
  ).at(0)?.meta

const rowFor = async (acme: string, id: string, viewer: { id: string }) => {
  const row = (
    await Effect.runPromise(recordTimelineProgram(acme, viewer))
  ).find((i) => i.id === id)
  if (row?.type !== 'interaction') throw new Error('no row')
  return row
}

describe('an email’s summary and categories', () => {
  it('is queued once per email when the mail lane writes it', async () => {
    const email = await syncEmail()
    expect(enqueued.filter((e) => e.name === QUEUES.summarizeEmail)).toEqual([
      {
        name: QUEUES.summarizeEmail,
        data: { interactionId: email.id },
        options: { singletonKey: email.id },
      },
    ])
  })

  it('writes both into meta through the two lanes; the row lists them for the owner', async () => {
    await route('normal', 'anthropic')
    const email = await syncEmail()
    const before = await rowFor(email.acme, email.id, OWNER)
    expect(before).toMatchObject({
      summary: null,
      snippet: 'Q3 revenue is up 40%. Could we talk',
    })

    const { model, calls } = mockModel()
    const r = await Effect.runPromise(
      summarizeEmailProgram({ interactionId: email.id, model }),
    )
    expect(r).toEqual({
      status: 'done',
      summary: 'written',
      categories: 'written',
    })
    expect(calls.sort()).toEqual(['classify', 'synthesize'])
    expect(await metaOf(email.id)).toMatchObject({
      kind: 'email',
      labels: ['Inbox'],
      summary: SUMMARY,
      // An answer outside the list is dropped.
      categories: ['update'],
    })
    expect(await rowFor(email.acme, email.id, OWNER)).toMatchObject({
      summary: SUMMARY,
      snippet: null,
      categories: ['update'],
    })
  })

  it('hides the summary, snippet and categories with the body from a teammate (D67)', async () => {
    await route('normal', 'anthropic')
    const email = await syncEmail()
    await Effect.runPromise(
      summarizeEmailProgram({
        interactionId: email.id,
        model: mockModel().model,
      }),
    )
    expect(await rowFor(email.acme, email.id, TEAMMATE)).toMatchObject({
      privateBody: true,
      subject: 'Acme — Q3 update',
      summary: null,
      snippet: null,
      categories: [],
    })
  })

  it('leaves a sensitive record’s email blank with no local route, and the row shows the snippet', async () => {
    await route('normal', 'anthropic')
    const email = await syncEmail()
    await Effect.runPromise(setEntitySensitiveProgram(email.acme, true))
    const { model, calls } = mockModel()
    const r = await Effect.runPromise(
      summarizeEmailProgram({ interactionId: email.id, model }),
    )
    expect(r).toEqual({
      status: 'done',
      summary: 'unrouted',
      categories: 'unrouted',
    })
    expect(calls).toEqual([])
    const meta = await metaOf(email.id)
    expect(meta?.kind === 'email' && meta.summary).toBe(undefined)
    expect(await rowFor(email.acme, email.id, OWNER)).toMatchObject({
      summary: null,
      snippet: 'Q3 revenue is up 40%. Could we talk',
      categories: [],
    })
  })

  it('refuses a sensitive record’s email to a cloud route', async () => {
    await route('sensitive', 'anthropic')
    const email = await syncEmail()
    await Effect.runPromise(setEntitySensitiveProgram(email.acme, true))
    const { model, calls } = mockModel()
    expect(
      await Effect.runPromise(
        summarizeEmailProgram({ interactionId: email.id, model }),
      ),
    ).toEqual({ status: 'done', summary: 'refused', categories: 'refused' })
    expect(calls).toEqual([])
  })

  it('summarises a sensitive record’s email on a local route', async () => {
    await route('sensitive', 'ollama')
    const email = await syncEmail()
    await Effect.runPromise(setEntitySensitiveProgram(email.acme, true))
    const r = await Effect.runPromise(
      summarizeEmailProgram({
        interactionId: email.id,
        model: mockModel().model,
      }),
    )
    expect(r).toMatchObject({ summary: 'written', categories: 'written' })
    expect(await rowFor(email.acme, email.id, OWNER)).toMatchObject({
      summary: SUMMARY,
    })
  })

  it('never rewrites what a lane wrote', async () => {
    await route('normal', 'anthropic')
    const email = await syncEmail()
    await Effect.runPromise(
      summarizeEmailProgram({
        interactionId: email.id,
        model: mockModel().model,
      }),
    )
    const again = mockModel()
    expect(
      await Effect.runPromise(
        summarizeEmailProgram({ interactionId: email.id, model: again.model }),
      ),
    ).toEqual({ status: 'done', summary: 'kept', categories: 'kept' })
    expect(again.calls).toEqual([])
  })
})

describe('the summary backfill', () => {
  it('writes the emails that lack one and leaves the written as they were', async () => {
    await route('normal', 'anthropic')
    const done = await syncEmail('Acme — already read')
    const missing = await syncEmail('Acme — not yet read')
    // A lane already answered the first, with words of its own.
    await db
      .update(interaction)
      .set({
        meta: {
          kind: 'email',
          from: 'jane@acme.io',
          to: [],
          cc: [],
          date: new Date().toISOString(),
          mime_blob_sha: null,
          summary: 'Written by an earlier run.',
          categories: ['intro'],
        },
      })
      .where(eq(interaction.id, done.id))

    const { model, calls } = mockModel()
    const r = await Effect.runPromise(summarizeEmailBackfillProgram({ model }))
    expect(r).toEqual({ written: 1, untouched: 0 })
    expect(calls.sort()).toEqual(['classify', 'synthesize'])
    expect(await metaOf(done.id)).toMatchObject({
      summary: 'Written by an earlier run.',
      categories: ['intro'],
    })
    expect(await metaOf(missing.id)).toMatchObject({ summary: SUMMARY })

    // A second run finds nothing to do and calls nothing.
    const quiet = mockModel()
    expect(
      await Effect.runPromise(
        summarizeEmailBackfillProgram({ model: quiet.model }),
      ),
    ).toEqual({ written: 0, untouched: 0 })
    expect(quiet.calls).toEqual([])
  })
})
