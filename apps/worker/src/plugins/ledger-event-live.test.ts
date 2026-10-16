import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  aiRoute,
  credential,
  document,
  entity,
  integration,
  storageBinding,
  suggestion,
} from '@spaces/db/schema'
import { mark, round } from '@spaces/db/schema/portfolio'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { storeCredential } from '@spaces/core/writes/vault'
import { FAKE_DRIVE_SEED, makeFakeDriveApi } from '@spaces/sdk/testing'
import type { FakeDriveApi } from '@spaces/sdk/testing'
import { enqueued } from '#web/test/queue-stub'
import { setAiRouteProgram } from '#web/lib/ai/route'
import { acceptProgram } from '#web/lib/ai/propose'
import { addInvestmentProgram, addRoundProgram } from '#web/lib/portfolio/write'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pluginBreakerLayer } from './breaker'
import { pluginsRootWith } from './fakes/enrichers'
import type { FakeProviders } from './fakes/switch'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { storageSourcesLayer } from './storage-source'
import { JobContext } from '../run-job'
import type { JobFailure, JobResult } from '../run-job'
import { ExtractionStore, extractDocument } from '../jobs/extract-document'
import { runLedgerEvent } from '../jobs/ledger-event'
import { pollStorageChanges } from '../jobs/poll-storage-changes'
import { syncStorageBinding } from '../jobs/sync-storage-binding'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * Live-file ledger events end to end on the real google-drive bundle: a
 * bound cap table edited in the fake Drive is revised by the poll, its
 * re-extraction enqueues exactly one read, and the read proposes exactly
 * one `ledger_event` on the held company — a replay adds nothing.
 */

const USER = FIXTURE_ACTOR.id

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
})

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(storageBinding).where(isNotNull(storageBinding.id))
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(credential).where(isNotNull(credential.id))
})

const CAP_TABLE_V1 =
  'Holder,Class,Shares\nFounders,Common,876000\nFund,Series A,124000'
const CAP_TABLE_V2 = `${CAP_TABLE_V1}\nNewco Ventures,Series B,265306`

/** The seed with its cap table as a CSV, so extraction reads real text. */
const SEED = FAKE_DRIVE_SEED.map((item) =>
  item.id === 'captable' && item.kind === 'file'
    ? {
        ...item,
        name: 'Cap table.csv',
        mime: 'text/csv',
        content: CAP_TABLE_V1,
      }
    : item,
)

const succeeded = (exit: Exit.Exit<JobResult, JobFailure>): JobResult => {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

const context = (queue: string) =>
  JobContext.of({
    queue,
    jobId: `test-${randomUUID()}`,
    attempt: 1,
    isFinalAttempt: true,
  })

async function wiredDrive(): Promise<{
  api: FakeDriveApi
  poll: () => Promise<Exit.Exit<JobResult, JobFailure>>
  sync: (bindingId: string) => Promise<Exit.Exit<JobResult, JobFailure>>
}> {
  const api = makeFakeDriveApi({ seed: SEED })
  const root = pluginsRootWith('ledger-event', ['google-drive'])
  await db.insert(integration).values({
    capabilityId: 'google-drive',
    version: '0.1.0',
    enabled: true,
    config: { folderId: 'dataroom' },
  })
  const fakes: FakeProviders = {
    standIn: (pluginId) =>
      pluginId === 'google-drive'
        ? {
            fetch: api.fetch,
            secret: 'fake-google-drive-key',
            accessToken: api.accessToken,
          }
        : null,
  }
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root, only: 'google-drive', fakes }),
  )
  const host = makePluginHost({ enqueue: NoEnqueue, fakes })
  hosts.push(host)
  await Effect.runPromise(host.wire(loaded))
  const layer = Layer.mergeAll(
    storageSourcesLayer(host, { fakes, pluginsRoot: root }),
    NoEnqueue,
    pluginBreakerLayer(host),
  )
  return {
    api,
    poll: () =>
      Effect.runPromiseExit(
        pollStorageChanges
          .run({})
          .pipe(
            Effect.provide(layer),
            Effect.provideService(
              JobContext,
              context(QUEUES.pollStorageChanges),
            ),
          ),
      ),
    sync: (bindingId) =>
      Effect.runPromiseExit(
        syncStorageBinding
          .run({ bindingId })
          .pipe(
            Effect.provide(layer),
            Effect.provideService(
              JobContext,
              context(QUEUES.syncStorageBinding),
            ),
          ),
      ),
  }
}

/** The extraction job as the worker runs it, store and all. */
const extract = (documentId: string) =>
  Effect.runPromiseExit(
    extractDocument
      .run({ documentId })
      .pipe(
        Effect.provide(ExtractionStore.layer),
        Effect.provideService(JobContext, context(QUEUES.extractDocument)),
      ),
  )

async function aConnection() {
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId: USER,
        provider: 'google',
        product: 'drive',
        externalEmail: `${randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          {
            accessToken: 'unused',
            refreshToken: 'refresh',
            tokenType: 'Bearer',
          },
          { userId: USER, provider: 'google' },
        ),
        scopes: ['openid', 'email', 'drive.file', 'drive.readonly'],
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (row === undefined) throw new Error('no connection')
  return row.id
}

/** 124,000 priced shares of a 1,000,000 fully diluted Series A: 12.4%. */
async function heldCompany() {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: 'Acme' })
      .returning({ id: entity.id })
  ).at(0)
  if (row === undefined) throw new Error('no company')
  await Effect.runPromise(
    addInvestmentProgram({
      companyId: row.id,
      date: '2025-01-10',
      amount: 500_000,
      currency: 'USD',
      instrument: 'priced',
      shares: 124_000,
      actorId: USER,
    }),
  )
  await Effect.runPromise(
    addRoundProgram({
      companyId: row.id,
      date: '2025-01-10',
      kind: 'Series A',
      sharesOutstanding: 1_000_000,
      actorId: USER,
    }),
  )
  return row.id
}

async function routeExtract() {
  await storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: 'sk-ant-test-ledger-live-0000',
    meta: {},
    createdBy: USER,
  })
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

/** The model, scripted: a Series B diluting us to 9.8%. */
const model = () =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: () =>
      Promise.resolve({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              round: {
                date: '2026-03-01',
                kind: 'Series B',
                raised: 4_000_000,
                currency: 'USD',
                sharesOutstanding: 1_265_306,
              },
              ownership: { ourShares: 124_000, fullyDilutedShares: 1_265_306 },
              reason: 'Newco Ventures joined in a Series B.',
            }),
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 40,
            noCache: 40,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      }),
  })

const ledgerJobs = () =>
  enqueued.filter((e) => e.name === QUEUES.proposeLedgerEvent)

describe('a bound cap table revised in Drive', () => {
  it('enqueues exactly one read and proposes exactly one ledger event; accepting appends one round', async () => {
    await routeExtract()
    const drive = await wiredDrive()
    const connectionId = await aConnection()
    const company = await heldCompany()
    const bindingId = (
      await Effect.runPromise(
        bindFolderProgram({
          connectionId,
          provider: 'google',
          folder: {
            folderId: 'dataroom',
            ancestorIds: ['root'],
            path: 'My Drive / Acme Data Room',
          },
          targetEntityId: company,
          boundBy: USER,
          options: {
            mapSubfolders: false,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        }),
      )
    ).id
    succeeded(await drive.poll())
    succeeded(await drive.sync(bindingId))
    const filed = (
      await db
        .select({
          id: document.entityId,
          kind: document.kind,
        })
        .from(document)
        .where(
          and(
            eq(document.externalId, 'captable'),
            eq(document.connectionId, connectionId),
          ),
        )
    ).at(0)
    if (filed === undefined) throw new Error('the walk filed no cap table')
    expect(filed.kind).toBe('cap_table')

    // The first filing's extraction proposes nothing: nothing moved.
    succeeded(await extract(filed.id))
    expect(ledgerJobs()).toEqual([])

    drive.api.drive.edit('captable', CAP_TABLE_V2)
    await db
      .update(storageBinding)
      .set({ lastSyncedAt: sql`now() - interval '1 hour'` })
      .where(isNotNull(storageBinding.id))
    expect(String(succeeded(await drive.poll()))).toMatch(/, 1 revised$/)
    const revision = drive.api.drive.entry('captable')?.changeToken
    if (revision === undefined) throw new Error('no change token')

    succeeded(await extract(filed.id))
    // A replayed extraction of the same revision is the same key.
    succeeded(await extract(filed.id))
    expect(ledgerJobs()).toEqual([
      {
        name: QUEUES.proposeLedgerEvent,
        data: { documentId: filed.id, revisionId: revision },
        options: { singletonKey: `${filed.id}:${revision}` },
      },
    ])

    const job = { documentId: filed.id, revisionId: revision }
    const proposed = await Effect.runPromise(
      runLedgerEvent(job, { model: model() }),
    )
    expect(proposed.status).toBe('proposed')
    // The job run again proposes nothing new.
    expect(
      (await Effect.runPromise(runLedgerEvent(job, { model: model() }))).status,
    ).toBe('skipped')

    const rows = await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.kind, 'ledger_event'))
    expect(rows).toHaveLength(1)
    const row = rows.at(0)
    if (row === undefined) throw new Error('no suggestion')
    expect(row.entityId).toBe(company)
    expect(row.payload).toMatchObject({
      event: 'round',
      revisionId: revision,
      before: { ownershipPct: 0.124, roundKind: 'Series A' },
      proposed: { date: '2026-03-01', kind: 'Series B', raised: 4_000_000 },
    })

    const rounds = async () => (await db.select().from(round)).length
    const marks = async () => (await db.select().from(mark)).length
    const before = { rounds: await rounds(), marks: await marks() }
    await Effect.runPromise(acceptProgram(row.id, { type: 'user', id: USER }))
    expect({ rounds: await rounds(), marks: await marks() }).toEqual({
      rounds: before.rounds + 1,
      marks: before.marks,
    })
  })
})
