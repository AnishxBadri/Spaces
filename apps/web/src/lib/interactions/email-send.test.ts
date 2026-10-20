import { randomUUID } from 'node:crypto'
import { Effect, Exit, Cause, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  emailDraft,
  entity,
  integration,
} from '@spaces/db/schema'
import type { OutgoingEmail } from '@spaces/sdk'
import { writeIntegrationInteraction } from '@spaces/core/writes/interactions/write'
import type { QueuedJob } from '@spaces/core/queue/sender'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { saveDraftProgram } from './email-drafts'
import type { DraftSave } from './email-drafts'
import {
  SendQueue,
  emailSenderProgram,
  mintMessageId,
  sendDraftProgram,
  settledOf,
} from './email-send'
import type { SendInput } from './email-send'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Send (D67) up to the queue: who sends, what each message is, what is
 * refused before any job, and what a settled job does to the draft. The
 * plugin half runs in the worker's live test; here a stand-in queue
 * settles each job as told.
 */

const ME = { id: FIXTURE_ACTOR.id }
const MAILBOX = 'anish@fund.example'

const MANIFEST = {
  manifestVersion: 1,
  id: 'gmail',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Gmail',
  description: 'Mail.',
  settings: {},
  jobs: {
    send: {
      trigger: 'action',
      input: 'payload',
      interactive: true,
      retry: 0,
      uses: ['Secrets', 'Http', 'Content', 'Log'],
    },
  },
}

let connectionId = ''
let integrationId = ''

const connect = async (scopes: Array<string>) => {
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: MAILBOX,
        tokensEnc: Buffer.from('never read'),
        scopes,
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!row) throw new Error('no connection')
  const bound = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'gmail',
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        manifest: MANIFEST,
        connectionId: row.id,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!bound) throw new Error('no integration')
  connectionId = row.id
  integrationId = bound.id
}

const SENDING = ['openid', 'email', 'gmail.readonly', 'gmail.send']

beforeEach(async () => {
  await truncateAndReseed()
  connectionId = ''
  integrationId = ''
})

type Outcome = 'sent' | { failed: string } | 'pending'

/** A queue whose jobs settle as `outcome` says; a sent one files its row. */
const standIn = (
  outcome: (payload: OutgoingEmail) => Outcome = () => 'sent',
) => {
  const sent: Array<OutgoingEmail> = []
  const jobs = new Map<string, Array<QueuedJob>>()
  const layer = Layer.succeed(
    SendQueue,
    SendQueue.of({
      enqueue: (_queue, payload, key) =>
        Effect.promise(async () => {
          sent.push(payload)
          const out = outcome(payload)
          if (out === 'sent') await fileOutgoing(payload)
          jobs.set(key, [
            out === 'pending'
              ? { state: 'active', output: null, createdOn: new Date() }
              : out === 'sent'
                ? {
                    state: 'completed',
                    output: { kind: 'completed', reason: '' },
                    createdOn: new Date(),
                  }
                : {
                    state: 'failed',
                    output: { kind: 'retryable', reason: out.failed },
                    createdOn: new Date(),
                  },
          ])
          return 'job'
        }),
      jobs: (_queue, key) => Effect.succeed(jobs.get(key) ?? null),
    }),
  )
  return { layer, sent }
}

/** The outgoing row the plugin's sent copy would land. */
const fileOutgoing = (payload: OutgoingEmail) =>
  db.transaction((tx) =>
    writeIntegrationInteraction(tx, {
      integrationId,
      kind: 'email',
      messageId: payload.messageId,
      threadId: null,
      subject: payload.subject,
      occurredAt: new Date(),
      meta: {
        kind: 'email',
        from: MAILBOX,
        to: payload.to.map((m) => m.email),
        cc: payload.cc.map((m) => m.email),
        ...(payload.bcc.length === 0
          ? {}
          : { bcc: payload.bcc.map((m) => m.email) }),
        date: new Date().toISOString(),
        mime_blob_sha: null,
      },
      body: null,
      edges: [],
    }),
  )

const draft = async (over: Partial<DraftSave> = {}) => {
  const id = randomUUID()
  await Effect.runPromise(
    saveDraftProgram(ME, {
      id,
      mode: 'new',
      inReplyToId: null,
      to: [{ email: 'dana@flent.example', name: 'Dana Moreau' }],
      cc: [{ email: 'kiran@flent.example' }],
      bcc: [{ email: 'priya@fund.example' }],
      subject: 'Flent — next steps',
      bodyMd: 'Thanks Dana.',
      attachments: [],
      ...over,
    }),
  )
  return id
}

const NO_FILLS = { fills: {}, accepted: [] }

const send = (
  queue: ReturnType<typeof standIn>,
  input: SendInput,
  timing = { waitMs: 2_000, pollMs: 10 },
) =>
  Effect.runPromiseExit(
    sendDraftProgram(ME, input, timing).pipe(Effect.provide(queue.layer)),
  )

const failure = <TValue, TError>(exit: Exit.Exit<TValue, TError>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : null

const draftHeld = async (id: string) =>
  (await db.select().from(emailDraft).where(eq(emailDraft.id, id))).length

const aDocument = async (name: string, sizeBytes: number) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no document')
  const sha = randomUUID().replaceAll('-', '').padEnd(64, '0')
  await db.insert(document).values({
    entityId: ent.id,
    filename: name,
    kind: 'other',
    mime: 'application/pdf',
    sizeBytes,
    blobSha: sha,
  })
  return { id: ent.id, sha }
}

describe('the sender', () => {
  it('says to connect Gmail when the viewer has no mailbox', async () => {
    expect(await Effect.runPromise(emailSenderProgram(ME, null))).toEqual({
      _tag: 'unavailable',
      reason: 'Connect Gmail to send',
      href: '/settings/email-calendar',
    })
  })

  it('names the account to reconnect when it lacks gmail.send', async () => {
    await connect(['openid', 'email', 'gmail.readonly'])
    expect(await Effect.runPromise(emailSenderProgram(ME, null))).toEqual({
      _tag: 'reconnect',
      from: MAILBOX,
      connectionId,
    })
  })

  it('is ready with gmail.send', async () => {
    await connect(SENDING)
    expect(await Effect.runPromise(emailSenderProgram(ME, null))).toEqual({
      _tag: 'ready',
      from: MAILBOX,
    })
  })
})

describe('sendDraftProgram', () => {
  it('refuses without gmail.send and queues nothing', async () => {
    await connect(['openid', 'email', 'gmail.readonly'])
    const id = await draft()
    const queue = standIn()
    expect(
      failure(await send(queue, { draftId: id, ...NO_FILLS })),
    ).toMatchObject({
      _tag: 'SendRefused',
      message: 'Reconnect Gmail to send',
    })
    expect(queue.sent).toHaveLength(0)
    expect(await draftHeld(id)).toBe(1)
  })

  it('sends one message to everyone, Bcc on the payload, and deletes the draft', async () => {
    await connect(SENDING)
    const id = await draft()
    const queue = standIn()
    const exit = await send(queue, { draftId: id, ...NO_FILLS })
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(queue.sent).toHaveLength(1)
    const payload = queue.sent.at(0)
    expect(payload).toMatchObject({
      messageId: mintMessageId(id, null, MAILBOX),
      from: { email: MAILBOX, name: FIXTURE_ACTOR.name },
      to: [{ email: 'dana@flent.example', name: 'Dana Moreau' }],
      cc: [{ email: 'kiran@flent.example' }],
      bcc: [{ email: 'priya@fund.example' }],
      inReplyTo: null,
      references: [],
      attachments: [],
    })
    expect(payload?.messageId).toBe(`spaces-${id}-all@fund.example`)
    expect(exit.value.sent).toBe(1)
    expect(exit.value.interactionIds).toHaveLength(1)
    expect(await draftHeld(id)).toBe(0)
  })

  it('threads a reply from the parent’s Message-ID and its thread', async () => {
    await connect(SENDING)
    const parent = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, {
        integrationId,
        kind: 'email',
        messageId: 'q3@flent.example',
        threadId: 'root@flent.example',
        subject: 'Flent Q3',
        occurredAt: new Date(),
        meta: {
          kind: 'email',
          from: 'dana@flent.example',
          to: [MAILBOX],
          cc: [],
          date: new Date().toISOString(),
          mime_blob_sha: null,
        },
        body: null,
        edges: [],
      }),
    )
    if (parent.kind !== 'written') throw new Error('no parent')
    const id = await draft({ mode: 'reply', inReplyToId: parent.interactionId })
    const queue = standIn()
    const exit = await send(queue, { draftId: id, ...NO_FILLS })
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(queue.sent.at(0)).toMatchObject({
      inReplyTo: 'q3@flent.example',
      references: ['root@flent.example', 'q3@flent.example'],
    })
  })

  it('refuses files over 25 MB before any job, naming the limit', async () => {
    await connect(SENDING)
    const big = await aDocument('data-room.zip', 26 * 1024 * 1024)
    const id = await draft({ attachments: [{ documentId: big.id }] })
    const queue = standIn()
    expect(
      failure(await send(queue, { draftId: id, ...NO_FILLS })),
    ).toMatchObject({
      _tag: 'AttachmentsTooLarge',
      limitBytes: 25 * 1024 * 1024,
      message: 'The files come to 26.0 MB; Gmail sends 25 MB at most',
    })
    expect(queue.sent).toHaveLength(0)
    expect(await draftHeld(id)).toBe(1)
  })

  it('hands each file over as a blob URL, with its name and size', async () => {
    await connect(SENDING)
    const deck = await aDocument('deck.pdf', 1200)
    const id = await draft({ attachments: [{ documentId: deck.id }] })
    const queue = standIn()
    const exit = await send(queue, { draftId: id, ...NO_FILLS })
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    const file = queue.sent.at(0)?.attachments.at(0)
    expect(file).toMatchObject({
      filename: 'deck.pdf',
      mime: 'application/pdf',
      sizeBytes: 1200,
    })
    expect(file?.url).toContain(`/api/blob/${deck.sha}?exp=`)
  })

  it('keeps the draft and says what Gmail said when the job fails', async () => {
    await connect(SENDING)
    const id = await draft()
    const queue = standIn(() => ({
      failed: 'Gmail answered 503: Backend Error',
    }))
    expect(
      failure(await send(queue, { draftId: id, ...NO_FILLS })),
    ).toMatchObject({
      _tag: 'SendFailed',
      message: 'Gmail answered 503: Backend Error. The draft is kept',
    })
    expect(await draftHeld(id)).toBe(1)
  })

  it('keeps the draft when Gmail has not answered in time', async () => {
    await connect(SENDING)
    const id = await draft()
    const queue = standIn(() => 'pending')
    const exit = await send(
      queue,
      { draftId: id, ...NO_FILLS },
      { waitMs: 50, pollMs: 10 },
    )
    expect(failure(exit)).toMatchObject({ _tag: 'SendFailed' })
    expect(await draftHeld(id)).toBe(1)
  })
})

describe('a draft with variables', () => {
  async function aFounder(email: string, first: string | null, last: string) {
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { setValues } = await import('@spaces/core/writes/attributes/values')
    const person = await resolveEntity({
      kind: 'person',
      name: [first, last].filter(Boolean).join(' '),
      keys: { email },
      source: { class: 'manual' },
    })
    await setValues({
      entityId: person.entityId,
      patch: { first_name: first, last_name: last },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    })
    return { email, entityId: person.entityId }
  }

  const personalised = async () => {
    await connect(SENDING)
    const dana = await aFounder('dana@flent.example', 'Dana', 'Moreau')
    const okafor = await aFounder('ade@northgate.example', null, 'Okafor')
    const id = await draft({
      to: [dana, okafor],
      cc: [{ email: 'kiran@flent.example' }],
      subject: 'Hello {{name.first}}',
      bodyMd: 'Hi {{name.first}}, about the round.',
    })
    return { id, dana, okafor }
  }

  it('refuses a blank neither filled nor left blank, and queues nothing', async () => {
    const { id } = await personalised()
    const queue = standIn()
    expect(
      failure(await send(queue, { draftId: id, ...NO_FILLS })),
    ).toMatchObject({
      _tag: 'SendRefused',
      message:
        '{{name.first}} is blank for ade@northgate.example: fill it or leave it blank',
    })
    expect(queue.sent).toHaveLength(0)
  })

  it('sends one message per To recipient, resolved here, Cc on each', async () => {
    const { id, dana, okafor } = await personalised()
    const queue = standIn()
    const exit = await send(queue, {
      draftId: id,
      fills: { [okafor.email]: { 'name.first': 'Ade' } },
      accepted: [],
    })
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(
      queue.sent.map((p) => [p.to.map((t) => t.email), p.subject, p.bodyMd]),
    ).toEqual([
      [[dana.email], 'Hello Dana', 'Hi Dana, about the round.'],
      [[okafor.email], 'Hello Ade', 'Hi Ade, about the round.'],
    ])
    for (const p of queue.sent)
      expect(p.cc).toEqual([{ email: 'kiran@flent.example' }])
    expect(new Set(queue.sent.map((p) => p.messageId)).size).toBe(2)
    expect(exit.value.interactionIds).toHaveLength(2)
    expect(await draftHeld(id)).toBe(0)
  })

  it('sends a blank left blank empty', async () => {
    const { id, okafor } = await personalised()
    const queue = standIn()
    const exit = await send(queue, {
      draftId: id,
      fills: {},
      accepted: [okafor.email],
    })
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(queue.sent.at(1)?.subject).toBe('Hello ')
  })

  it('after a partial failure keeps the draft, and the next press sends only what is left', async () => {
    const { id, okafor } = await personalised()
    const fills = { [okafor.email]: { 'name.first': 'Ade' } }
    const first = standIn((p) =>
      p.to.at(0)?.email === okafor.email
        ? { failed: 'Gmail answered 500' }
        : 'sent',
    )
    expect(
      failure(await send(first, { draftId: id, fills, accepted: [] })),
    ).toMatchObject({
      _tag: 'SendFailed',
      message: 'Sent 1 of 2. Gmail answered 500. The draft is kept',
    })
    expect(await draftHeld(id)).toBe(1)
    const second = standIn()
    const exit = await send(second, { draftId: id, fills, accepted: [] })
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(second.sent.map((p) => p.to.at(0)?.email)).toEqual([okafor.email])
    expect(await draftHeld(id)).toBe(0)
  })
})

describe('settledOf', () => {
  it('reads a rate-limited completion as still going', () => {
    const at = new Date()
    expect(
      settledOf([
        {
          state: 'completed',
          output: { kind: 'rate-limited', reason: 'x' },
          createdOn: at,
        },
      ]),
    ).toEqual({ _tag: 'pending' })
    expect(settledOf(null)).toEqual({ _tag: 'pending' })
  })
})
