import { createHash, randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer } from 'effect'
import { and, count, desc, eq, isNotNull } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  emailDraft,
  entity,
  entityAlias,
  integration,
  interaction,
  interactionEntity,
  interactionStat,
  jobRun,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { storage } from '@spaces/core/writes/storage'
import { verifyBlobToken } from '@spaces/core/writes/storage/local'
import { FAKE_GMAIL_OWNER } from '@spaces/sdk/testing'
import type { FakeGmailApi } from '@spaces/sdk/testing'
import { saveDraftProgram } from '#web/lib/interactions/email-drafts'
import type { DraftSave } from '#web/lib/interactions/email-drafts'
import {
  SendQueue,
  emailSenderProgram,
  sendDraftProgram,
} from '#web/lib/interactions/email-send'
import { truncateAndReseed } from '#web/test/reseed'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pgBossHost } from '../run-job'
import { pluginsRootWith } from './fakes/enrichers'
import { cassetteProviders } from './fakes/registry'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { mailLaneLive } from './mail'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * Send end to end under `SPACES_FAKE_PROVIDERS=1`: the composer's
 * program queues the real gmail bundle's `send` on a real pg-boss and waits
 * for it; the fake Gmail takes the message and the mail lane writes the
 * outgoing row from the sent copy. Then the sync runs and dedupes on the
 * Message-ID. `fetch` serves the blob backend's signed URLs and nothing
 * else, so no request reaches a network.
 */

const SYNC = 'plugin.gmail.sync'
const HOUR = 3_600_000
const ME = { id: FIXTURE_ACTOR.id }
const SENDING = ['openid', 'email', 'gmail.readonly', 'gmail.send']
const TIMING = { waitMs: 30_000, pollMs: 200 }

let boss: PgBoss

const dropPluginQueues = async () => {
  for (const queue of await boss.getQueues())
    if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
}

/** The blob route, in process: a signed GET answers the stored bytes. */
const blobRoute = async (target: string): Promise<Response> => {
  const url = new URL(target)
  const key = /^\/api\/blob\/([a-f0-9]{64})$/.exec(url.pathname)?.[1]
  const exp = Number(url.searchParams.get('exp'))
  const sig = url.searchParams.get('sig') ?? ''
  if (key === undefined || !verifyBlobToken(key, 'get', exp, sig))
    return new Response('forbidden', { status: 403 })
  return new Response(Buffer.from(await storage().getBytes(key)), {
    status: 200,
  })
}

beforeAll(async () => {
  vi.stubGlobal('fetch', (target: string) => {
    if (new URL(target).pathname.startsWith('/api/blob/'))
      return blobRoute(target)
    throw new Error('the send suite must not reach the network')
  })
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined) throw new Error('DATABASE_URL is unset')
  boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    schedule: false,
    supervise: false,
  })
  boss.on('error', (error: Error) => console.error('[pg-boss]', error))
  await boss.start()
  await dropPluginQueues()
})

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  await dropPluginQueues()
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

afterAll(async () => {
  await boss.stop({ graceful: false })
  vi.unstubAllGlobals()
})

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

/** The composer's program on this suite's pg-boss. */
const bossQueue = Layer.succeed(
  SendQueue,
  SendQueue.of({
    enqueue: (queue, payload, key) =>
      Effect.promise(() =>
        boss.send(queue, { payload }, { singletonKey: key }),
      ),
    jobs: (queue, key) => Effect.promise(() => boss.findJobs(queue, { key })),
  }),
)

const waitFor = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> => {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const boot = async (scopes: Array<string> = SENDING) => {
  await truncateAndReseed()
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: FAKE_GMAIL_OWNER,
        tokensEnc: Buffer.from('fake'),
        scopes,
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
      .returning()
  ).at(0)
  if (!row) throw new Error('no integration row')
  const fakes = cassetteProviders()
  const api: FakeGmailApi | null = fakes.gmail('gmail')
  if (api === null) throw new Error('no fake mailbox')
  const host = makePluginHost({
    enqueue: noEnqueue,
    mail: mailLaneLive,
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    fakes,
  })
  hosts.push(host)
  const { loaded, verdicts } = await Effect.runPromise(
    reconcilePlugins({
      pluginsRoot: pluginsRootWith('gmail', ['gmail']),
      only: 'gmail',
      fakes,
    }),
  )
  expect(verdicts.map((v) => [v.status, v.reason])).toEqual([['enabled', null]])
  await Effect.runPromise(host.wire(loaded))
  return { row, api, host, connectionId: connection.id }
}

/** One sync tick, waited out until its `job_run` row closes. */
const tick = async (integrationId: string) => {
  const runs = () =>
    db
      .select({ status: jobRun.status })
      .from(jobRun)
      .where(
        and(eq(jobRun.queue, SYNC), eq(jobRun.integrationId, integrationId)),
      )
      .orderBy(desc(jobRun.startedAt))
  const before = (await runs()).length
  if ((await boss.send(SYNC, {})) === null) throw new Error('no tick')
  const closed = await waitFor(
    runs,
    (rows) => rows.length > before && rows.every((r) => r.status !== 'running'),
  )
  expect(closed.at(0)?.status).toBe('succeeded')
}

const aPerson = async (name: string, email: string) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'person', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no person')
  await db.insert(entityAlias).values({
    entityId: ent.id,
    kind: 'email',
    value: email,
    valueNorm: email,
    isIdentity: true,
  })
  return ent.id
}

const aFile = async (filename: string, content: string, sizeBytes?: number) => {
  const bytes = Buffer.from(content)
  const sha = createHash('sha256').update(bytes).digest('hex')
  await storage().put(sha, bytes, { mime: 'application/pdf' })
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: filename })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no document')
  await db.insert(document).values({
    entityId: ent.id,
    filename,
    kind: 'other',
    mime: 'application/pdf',
    sizeBytes: sizeBytes ?? bytes.length,
    blobSha: sha,
  })
  return { id: ent.id, bytes }
}

const draft = async (over: Partial<DraftSave> = {}) => {
  const id = randomUUID()
  await Effect.runPromise(
    saveDraftProgram(ME, {
      id,
      mode: 'new',
      inReplyToId: null,
      to: [{ email: 'jane@acme-robotics.example', name: 'Jane Founder' }],
      cc: [],
      bcc: [],
      subject: 'Acme — next steps',
      bodyMd: 'Thanks Jane — sending the term sheet this week.',
      attachments: [],
      ...over,
    }),
  )
  return id
}

const send = (draftId: string) =>
  Effect.runPromiseExit(
    sendDraftProgram(ME, { draftId, fills: {}, accepted: [] }, TIMING).pipe(
      Effect.provide(bossQueue),
    ),
  )

const rowsOf = (messageId: string) =>
  db.select().from(interaction).where(eq(interaction.messageId, messageId))

const draftHeld = async (id: string) =>
  (
    await db
      .select({ n: count() })
      .from(emailDraft)
      .where(eq(emailDraft.id, id))
  ).at(0)?.n ?? 0

const edgesOf = async (interactionId: string) =>
  (
    await db
      .select({ id: interactionEntity.entityId })
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, interactionId))
  ).map((r) => r.id)

const companyOf = async (domain: string) =>
  (
    await db
      .select({ id: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(eq(entityAlias.kind, 'domain'), eq(entityAlias.valueNorm, domain)),
      )
  ).at(0)?.id ?? null

const sends = (api: FakeGmailApi) =>
  api.requests.filter((r) => r.path === '/users/me/messages/send')

describe('send through gmail with the fakes on', () => {
  it('writes one outgoing row at once with the minted Message-ID, its Bcc hidden, no draft — and the sync does not double it', async () => {
    const { row, api, host } = await boot()
    expect(host.granted(row.id, 'send')).toEqual([
      'Content',
      'Http',
      'Log',
      'Secrets',
    ])
    const priya = await aPerson('Priya Nair', 'priya@fund.example')
    const id = await draft({ bcc: [{ email: 'priya@fund.example' }] })

    const exit = await send(id)
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    const messageId = `spaces-${id}-all@fund.example`
    expect(api.sent().map((m) => m.headers['message-id'])).toEqual([
      `<${messageId}>`,
    ])
    expect(api.sent().at(0)?.headers.bcc).toBe('priya@fund.example')

    const rows = await rowsOf(messageId)
    expect(rows).toHaveLength(1)
    const sent = rows.at(0)
    expect(exit.value.interactionIds).toEqual([sent?.id])
    expect(sent).toMatchObject({
      kind: 'email',
      sourceClass: 'integration',
      sourceRef: row.id,
      subject: 'Acme — next steps',
      meta: {
        kind: 'email',
        from: FAKE_GMAIL_OWNER,
        to: ['jane@acme-robotics.example'],
        bcc: ['priya@fund.example'],
        labels: ['Sent'],
      },
    })
    // Participants resolved: the recipient's company is on the row; the
    // Bcc is on no record and in no stat.
    const edges = await edgesOf(sent?.id ?? '')
    expect(edges).toContain(await companyOf('acme-robotics.example'))
    expect(edges).not.toContain(priya)
    expect(
      await db
        .select()
        .from(interactionStat)
        .where(eq(interactionStat.entityId, priya)),
    ).toEqual([])
    expect(await draftHeld(id)).toBe(0)

    // The sync lists the sent message from the mailbox; the Message-ID holds.
    await tick(row.id)
    expect(await rowsOf(messageId)).toHaveLength(1)
    await tick(row.id)
    expect(await rowsOf(messageId)).toHaveLength(1)
  }, 90_000)

  it('replies into the parent’s thread: the fake saw In-Reply-To and References, and the row lands on the company at once', async () => {
    const { row, api } = await boot()
    await tick(row.id)
    const parent = (await rowsOf('acme-q3@acme-robotics.example')).at(0)
    if (parent === undefined) throw new Error('the sync filed no parent')
    const id = await draft({
      mode: 'reply',
      inReplyToId: parent.id,
      subject: 'Re: Acme Robotics — Q3 update',
    })
    const exit = await send(id)
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    const out = api.sent().at(0)
    expect(out?.headers['in-reply-to']).toBe('<acme-q3@acme-robotics.example>')
    expect(out?.headers.references).toBe('<acme-q3@acme-robotics.example>')
    // Gmail's own thread joined, found by the parent's Message-ID.
    expect(out?.threadId).toBe('m-acme-update')

    const reply = (await rowsOf(`spaces-${id}-all@fund.example`)).at(0)
    expect(reply?.threadId).toBe(parent.threadId)
    expect(await edgesOf(reply?.id ?? '')).toContain(
      await companyOf('acme-robotics.example'),
    )
    await tick(row.id)
    expect(await rowsOf(`spaces-${id}-all@fund.example`)).toHaveLength(1)
  }, 90_000)

  it('reads each file from the blob backend and attaches it once', async () => {
    const { api } = await boot()
    const deck = await aFile('deck.pdf', '%PDF-1.4 the deck %%EOF')
    const model = await aFile('model.pdf', '%PDF-1.4 the model %%EOF')
    const id = await draft({
      attachments: [{ documentId: deck.id }, { documentId: model.id }],
    })
    const exit = await send(id)
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(sends(api)).toHaveLength(1)
    const files = (api.sent().at(0)?.parts ?? []).filter(
      (p) => p.filename !== null,
    )
    expect(files.map((f) => f.filename)).toEqual(['deck.pdf', 'model.pdf'])
    expect(Buffer.from(files.at(0)?.bytes ?? new Uint8Array())).toEqual(
      deck.bytes,
    )
    expect(Buffer.from(files.at(1)?.bytes ?? new Uint8Array())).toEqual(
      model.bytes,
    )
  }, 90_000)

  it('keeps the draft and surfaces Gmail’s words on a 5xx', async () => {
    const { api } = await boot()
    const id = await draft()
    api.failNext(503, 'Backend Error', '/users/me/messages/send')
    const exit = await send(id)
    expect(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : null,
    ).toMatchObject({
      _tag: 'SendFailed',
      message: 'Gmail answered 503: Backend Error. The draft is kept',
    })
    expect(api.sent()).toHaveLength(0)
    expect(await draftHeld(id)).toBe(1)
    expect(await rowsOf(`spaces-${id}-all@fund.example`)).toHaveLength(0)
  }, 90_000)
})

describe('refused before any request', () => {
  it('refuses files over 25 MB, naming the limit, and Gmail hears nothing', async () => {
    const { api } = await boot()
    const big = await aFile('data-room.pdf', 'x', 26 * 1024 * 1024)
    const id = await draft({ attachments: [{ documentId: big.id }] })
    const exit = await send(id)
    expect(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : null,
    ).toMatchObject({
      _tag: 'AttachmentsTooLarge',
      message: 'The files come to 26.0 MB; Gmail sends 25 MB at most',
    })
    expect(api.requests).toHaveLength(0)
    expect(await draftHeld(id)).toBe(1)
  }, 60_000)

  it('names Gmail and its account page when the grant lacks gmail.send', async () => {
    const { api, connectionId } = await boot([
      'openid',
      'email',
      'gmail.readonly',
    ])
    expect(await Effect.runPromise(emailSenderProgram(ME, null))).toEqual({
      _tag: 'reconnect',
      from: FAKE_GMAIL_OWNER,
      connectionId,
    })
    const id = await draft()
    const exit = await send(id)
    expect(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : null,
    ).toMatchObject({
      _tag: 'SendRefused',
      message: 'Reconnect Gmail to send',
    })
    expect(api.requests).toHaveLength(0)
    expect(await draftHeld(id)).toBe(1)
  }, 60_000)
})
