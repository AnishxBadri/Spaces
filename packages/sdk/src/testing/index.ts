import { Effect, Layer, Redacted } from 'effect'
import type { z } from 'zod'
import { JobPermanent, JobRateLimited } from '../contract.ts'
import { normalizeDomain, normalizeEmail } from '../identity/normalize.ts'
import type {
  EntityId,
  IdentityKeys,
  JobError,
  JsonObject,
  JsonValue,
  PortName,
  SignalClaim,
} from '../contract.ts'
import { landImportGrid } from '../import-grid.ts'
import { vocabularyProblem } from '../vocabulary.ts'
import type { LandedRow } from '../import-grid.ts'
import {
  Ai,
  Config,
  Content,
  Facts,
  Http,
  Identity,
  Import,
  Judgment,
  Log,
  NotConnected,
  Read,
  Receipts,
  Secrets,
  Spaces,
} from '../ports.ts'
import type {
  AiItem,
  AiLane,
  FactConflict,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  LogFields,
  ReadEntity,
  SpaceBrief,
  StageResult,
} from '../ports.ts'

/**
 * `@spaces/sdk/testing` (sdk-5; docs/spec-plugin-sdk.md §6, §13.1): the port
 * Layers a plugin author tests with — in memory, no Postgres, no network.
 * Each `XTest(…)` returns `{ layer, calls }`: the Layer to provide and a
 * recorder listing every call it received, in order, with what it returned.
 * Where a lane would mint an id, the fake mints a deterministic one
 * (`entity-1`, `receipt-1`, …), counting per test Layer, so a job can
 * resolve an entity and then fill it and a snapshot stays stable.
 *
 * `testPorts(…)` builds them all over one shared recorder, which is what a
 * job test usually wants: one Layer, one ordered list of port calls.
 *
 * Not here: `PluginDb`, whose behaviour is Postgres's own — a plugin's SQL is tested against a real
 * database, as the worker's PluginDb test does. A DryRun Layer (this recorder in production, over core's
 * `previewResolve`) is the later answer to an importer preview. Nor
 * `Discover`: the host has no live port for a fake to mirror.
 */

export type RecordedCall = {
  readonly port: PortName
  readonly method: string
  readonly input: unknown
  readonly output: unknown
}

/** An ordered list of port calls, shared by every Layer given it. */
export type Recorder = {
  readonly calls: ReadonlyArray<RecordedCall>
  readonly record: (call: RecordedCall) => void
}

export const makeRecorder = (): Recorder => {
  const calls: Array<RecordedCall> = []
  return { calls, record: (call) => void calls.push(call) }
}

export type TestPort<TService> = {
  readonly layer: Layer.Layer<TService>
  /** This port's calls only, in order. */
  readonly calls: ReadonlyArray<RecordedCall>
}

/** A recorder that also feeds the shared one, when there is one. */
const tap = (port: PortName, shared: Recorder | undefined) => {
  const own = makeRecorder()
  const record = <TOutput>(
    method: string,
    input: unknown,
    output: TOutput,
  ): TOutput => {
    const call = { port, method, input, output }
    own.record(call)
    shared?.record(call)
    return output
  }
  return { calls: own.calls, record }
}

const counter = (prefix: string) => {
  let n = 0
  return () => `${prefix}-${++n}`
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The key forms the fake treats as equal — the choke point's own
 * normalizers (`@spaces/sdk/identity`, sdk-4b), key for key as
 * `resolveEntity` maps them. A key that normalizes to nothing (a free-mail
 * domain, a malformed email) identifies nothing, here as there, and neither
 * does a LinkedIn URL.
 */
const KEY_KINDS = ['domain', 'email'] as const

const NORMALIZERS: {
  readonly [K in (typeof KEY_KINDS)[number]]: (raw: string) => string | null
} = {
  domain: normalizeDomain,
  email: normalizeEmail,
}

/**
 * `resolve` attaches to the entity any of the claim's keys already names in
 * this run, else mints `entity-<n>`; the same normalized keys therefore
 * always give the same id. `known` seeds entities that exist before the job
 * runs (`{ 'entity-7': { domain: 'stripe.com' } }`).
 */
export const IdentityTest = (
  options: {
    readonly known?: { readonly [entityId: string]: IdentityKeys }
    readonly recorder?: Recorder
  } = {},
): TestPort<Identity> => {
  const { calls, record } = tap('Identity', options.recorder)
  const nextId = counter('entity')
  const owners = new Map<string, EntityId>()
  const keysOf = (keys: IdentityKeys) =>
    KEY_KINDS.flatMap((kind) => {
      const raw = keys[kind]
      const norm = raw === undefined ? null : NORMALIZERS[kind](raw)
      return norm === null ? [] : [{ kind, norm: `${kind}:${norm}` }]
    })
  for (const [entityId, keys] of Object.entries(options.known ?? {})) {
    for (const k of keysOf(keys)) owners.set(k.norm, entityId)
  }
  const layer = Layer.succeed(Identity, {
    resolve: (claim) =>
      Effect.sync(() => {
        const keys = keysOf(claim.keys)
        const existing = keys
          .map((k) => owners.get(k.norm))
          .find((id) => id !== undefined)
        const entityId = existing ?? nextId()
        for (const k of keys)
          if (!owners.has(k.norm)) owners.set(k.norm, entityId)
        return record('resolve', claim, {
          entityId,
          outcome:
            existing === undefined
              ? ('created' as const)
              : ('attached' as const),
        })
      }),
    addAlias: (claim) =>
      Effect.sync(() =>
        record('addAlias', claim, {
          keys: keysOf(claim.keys).map((k) => {
            const holder = owners.get(k.norm)
            if (holder === undefined) owners.set(k.norm, claim.entityId)
            return {
              key: k.kind,
              outcome:
                holder === undefined
                  ? ('added' as const)
                  : holder === claim.entityId
                    ? ('already_own' as const)
                    : ('suggested_duplicate' as const),
            }
          }),
        }),
      ),
  })
  return { layer, calls }
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * Fill-blanks, as the lane does it: a slug with a human's value (`human`)
 * is refused and returned as a conflict; anything else is written. `values`
 * is what the fake holds after the job — the test's view of the record.
 *
 * `answer` refuses a key outside the vocabulary, as the live port does, and
 * holds every answer in `answers` by vocabulary key. `linked` names the keys
 * the fake treats as linked to an attribute; absent, every key is.
 */
export const FactsTest = (
  options: {
    readonly human?: { readonly [entityId: string]: JsonObject }
    readonly linked?: ReadonlyArray<string>
    readonly recorder?: Recorder
  } = {},
): TestPort<Facts> & {
  readonly values: ReadonlyMap<EntityId, JsonObject>
  readonly answers: ReadonlyMap<EntityId, JsonObject>
} => {
  const { calls, record } = tap('Facts', options.recorder)
  const values = new Map<EntityId, JsonObject>()
  const answers = new Map<EntityId, JsonObject>()
  const layer = Layer.succeed(Facts, {
    answer: (claim) => {
      const refused = Object.entries(claim.answers)
        .map(([key, value]) => vocabularyProblem(key, value))
        .find((problem) => problem !== null)
      if (refused !== undefined)
        return Effect.fail(
          new JobPermanent({ reason: `Facts.answer: ${refused}` }),
        )
      return Effect.sync(() => {
        answers.set(claim.entityId, {
          ...answers.get(claim.entityId),
          ...claim.answers,
        })
        const keys = Object.keys(claim.answers)
        const isLinked = (key: string) =>
          options.linked === undefined || options.linked.includes(key)
        return record('answer', claim, {
          linked: keys.filter(isLinked),
          unlinked: keys.filter((key) => !isLinked(key)),
        })
      })
    },
    fill: (claim) =>
      Effect.sync(() => {
        const human = options.human?.[claim.entityId] ?? {}
        const conflicts: Array<FactConflict> = []
        const written: { [slug: string]: JsonValue } = {
          ...values.get(claim.entityId),
        }
        for (const [slug, proposed] of Object.entries(claim.values)) {
          const existing = Object.hasOwn(human, slug) ? human[slug] : null
          if (existing !== null) {
            conflicts.push({ slug, existing, proposed })
          } else {
            written[slug] = proposed
          }
        }
        values.set(claim.entityId, written)
        return record('fill', claim, { conflicts })
      }),
  })
  return { layer, calls, values, answers }
}

// ---------------------------------------------------------------------------
// Content, Judgment, Receipts
// ---------------------------------------------------------------------------

/**
 * Interactions dedupe on `messageId` and signals on `key` per record, as the
 * lanes do; documents never. `signals` is every signal written, a deduped
 * emit left out.
 */
export const ContentTest = (
  options: { readonly recorder?: Recorder } = {},
): TestPort<Content> & { readonly signals: ReadonlyArray<SignalClaim> } => {
  const { calls, record } = tap('Content', options.recorder)
  const nextDocument = counter('document')
  const nextInteraction = counter('interaction')
  const nextSignal = counter('signal')
  const byMessageId = new Map<string, string>()
  const byKey = new Map<string, string>()
  const signals: Array<SignalClaim> = []
  const layer = Layer.succeed(Content, {
    fileDocument: (claim) =>
      Effect.sync(() => {
        // A stream is recorded as its presence, not its bytes.
        const input =
          'stream' in claim.body
            ? { ...claim, body: { stream: '<stream>' } }
            : claim
        return record('fileDocument', input, { documentId: nextDocument() })
      }),
    logInteraction: (claim) =>
      Effect.sync(() => {
        const seen =
          claim.messageId === undefined
            ? undefined
            : byMessageId.get(claim.messageId)
        const interactionId = seen ?? nextInteraction()
        if (claim.messageId !== undefined)
          byMessageId.set(claim.messageId, interactionId)
        return record('logInteraction', claim, { interactionId })
      }),
    emitSignal: (claim) =>
      Effect.sync(() => {
        const keyed =
          claim.key === undefined ? null : `${claim.entityId} ${claim.key}`
        const seen = keyed === null ? undefined : byKey.get(keyed)
        if (seen !== undefined)
          return record('emitSignal', claim, { signalId: seen })
        const signalId = nextSignal()
        if (keyed !== null) byKey.set(keyed, signalId)
        signals.push(claim)
        return record('emitSignal', claim, { signalId })
      }),
  })
  return { layer, calls, signals }
}

export const JudgmentTest = (
  options: { readonly recorder?: Recorder } = {},
): TestPort<Judgment> => {
  const { calls, record } = tap('Judgment', options.recorder)
  const next = counter('suggestion')
  const layer = Layer.succeed(Judgment, {
    suggest: (claim) =>
      Effect.sync(() => record('suggest', claim, { suggestionId: next() })),
  })
  return { layer, calls }
}

export const ReceiptsTest = (
  options: { readonly recorder?: Recorder } = {},
): TestPort<Receipts> => {
  const { calls, record } = tap('Receipts', options.recorder)
  const next = counter('receipt')
  const layer = Layer.succeed(Receipts, {
    store: (claim) =>
      Effect.sync(() => record('store', claim, { receiptId: next() })),
  })
  return { layer, calls }
}

// ---------------------------------------------------------------------------
// Ai
// ---------------------------------------------------------------------------

/** What a lane answers: `text` for a plain call, `object` for one with a schema. */
export type AiAnswer = {
  readonly text?: string
  readonly object?: JsonValue
}

/**
 * `complete` answers from `answers` by lane: a plain call gets the scripted
 * `text` (`<lane> answer` when none), a call with a schema gets the scripted
 * `object` parsed by it — none, or one the schema refuses, fails permanently,
 * as the live port does. Items are recorded as `{ ref, text }`.
 */
export const AiTest = (
  options: {
    readonly answers?: { readonly [L in AiLane]?: AiAnswer }
    readonly recorder?: Recorder
  } = {},
): TestPort<Ai> => {
  const { calls, record } = tap('Ai', options.recorder)
  const input = (lane: AiLane, items: ReadonlyArray<AiItem>) => ({
    lane,
    items: items.map((item) => ({ ref: item.ref, text: item.text })),
  })
  function complete(
    lane: AiLane,
    items: ReadonlyArray<AiItem>,
  ): Effect.Effect<string, JobError>
  function complete<TResult>(
    lane: AiLane,
    items: ReadonlyArray<AiItem>,
    schema: z.ZodType<TResult>,
  ): Effect.Effect<TResult, JobError>
  function complete<TResult>(
    lane: AiLane,
    items: ReadonlyArray<AiItem>,
    schema?: z.ZodType<TResult>,
  ): Effect.Effect<string | TResult, JobError> {
    const answer = options.answers?.[lane]
    if (schema === undefined)
      return Effect.sync(() =>
        record(
          'complete',
          input(lane, items),
          answer?.text ?? `${lane} answer`,
        ),
      )
    const parsed = schema.safeParse(answer?.object)
    return parsed.success
      ? Effect.sync(() => record('complete', input(lane, items), parsed.data))
      : Effect.fail(
          new JobPermanent({
            reason: `Ai.complete: no ${lane} answer the schema accepts`,
          }),
        )
  }
  return { layer: Layer.succeed(Ai, Ai.of({ complete })), calls }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** A readable record for `ReadTest`, with the parts a test does not care about defaulted. */
export const readEntity = (
  entity: Pick<ReadEntity, 'id' | 'name'> & Partial<ReadEntity>,
): ReadEntity => ({
  kind: 'company',
  values: {},
  ...entity,
  keys: {
    domain: [],
    email: [],
    linkedin: [],
    ...entity.keys,
  },
})

/**
 * `entity` answers from `entities` and is null for anything else — which is
 * also how the live port answers an id the integration may not read.
 * `search` is a case-insensitive substring match on the name.
 */
export const ReadTest = (
  options: {
    readonly entities?: ReadonlyArray<ReadEntity>
    readonly recorder?: Recorder
  } = {},
): TestPort<Read> => {
  const { calls, record } = tap('Read', options.recorder)
  const entities = options.entities ?? []
  const layer = Layer.succeed(Read, {
    entity: (id) =>
      Effect.sync(() =>
        record('entity', { id }, entities.find((e) => e.id === id) ?? null),
      ),
    search: (query, searchOptions) =>
      Effect.sync(() => {
        const q = query.trim().toLowerCase()
        const hits = entities
          .filter((e) => e.name.toLowerCase().includes(q))
          .filter((e) => searchOptions?.kinds?.includes(e.kind) ?? true)
          .slice(0, searchOptions?.limit ?? 20)
          .map((e) => ({ entityId: e.id, kind: e.kind, name: e.name }))
        return record('search', { query, options: searchOptions ?? {} }, hits)
      }),
  })
  return { layer, calls }
}

// ---------------------------------------------------------------------------
// Secrets, Config
// ---------------------------------------------------------------------------

/**
 * `get` hands back `secret` (redacted) or fails permanently, as a job with
 * no credential configured would; `accessToken` fails `NotConnected` unless
 * one is given. The recorder never holds the secret itself.
 */
export const SecretsTest = (
  options: {
    readonly secret?: string
    readonly accessToken?: string
    readonly recorder?: Recorder
  } = {},
): TestPort<Secrets> => {
  const { calls, record } = tap('Secrets', options.recorder)
  const { secret, accessToken } = options
  const layer = Layer.succeed(Secrets, {
    get: () =>
      Effect.suspend(() => {
        if (secret === undefined) {
          record('get', {}, '<none>')
          return Effect.fail(
            new JobPermanent({ reason: 'no credential is configured' }),
          )
        }
        record('get', {}, '<redacted>')
        return Effect.succeed(Redacted.make(secret))
      }),
    accessToken: () =>
      Effect.suspend(() => {
        if (accessToken === undefined) {
          record('accessToken', {}, '<not connected>')
          return Effect.fail(
            new NotConnected({ reason: 'no connection in this test' }),
          )
        }
        record('accessToken', {}, '<redacted>')
        return Effect.succeed(Redacted.make(accessToken))
      }),
  })
  return { layer, calls }
}

export const ConfigTest = (
  config: JsonObject = {},
  options: { readonly recorder?: Recorder } = {},
): TestPort<Config> => {
  const { calls, record } = tap('Config', options.recorder)
  const layer = Layer.succeed(Config, {
    get: () => Effect.sync(() => record('get', {}, config)),
  })
  return { layer, calls }
}

// ---------------------------------------------------------------------------
// Http
// ---------------------------------------------------------------------------

export type ScriptedResponse = {
  readonly status?: number
  readonly headers?: { readonly [name: string]: string }
  /** A string is the body as-is; anything else is serialised as JSON. */
  readonly body?: string | JsonValue
}

export type HttpScript = {
  readonly method?: HttpMethod
  /** A string matches the whole URL; a RegExp tests it. */
  readonly url: string | RegExp
  readonly response: ScriptedResponse
  /** Answer every matching request, not just the first. */
  readonly repeat?: boolean
}

const lowerKeys = (headers: { readonly [name: string]: string } = {}) =>
  Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )

/**
 * Scripted responses, consumed in order: each request takes the first entry
 * that matches it (and removes it, unless `repeat`). A request nothing
 * matches fails permanently, naming it — no request reaches a network. A
 * scripted 429 fails `JobRateLimited` with `Retry-After` as the delay,
 * exactly as the live port maps it, so a job's throttle handling is
 * testable; any other status comes back as a response. Every request is
 * recorded with its exact headers.
 */
export const HttpTest = (
  script: ReadonlyArray<HttpScript> = [],
  options: { readonly recorder?: Recorder } = {},
): TestPort<Http> => {
  const { calls, record } = tap('Http', options.recorder)
  const pending = [...script]
  const answer = (method: 'request' | 'stream', request: HttpRequest) =>
    Effect.suspend((): Effect.Effect<HttpResponse, JobError> => {
      const input = { ...request, headers: lowerKeys(request.headers) }
      const at = pending.findIndex(
        (s) =>
          (s.method ?? 'GET') === request.method &&
          (typeof s.url === 'string'
            ? s.url === request.url
            : s.url.test(request.url)),
      )
      const entry = at < 0 ? undefined : pending[at]
      if (entry === undefined) {
        record(method, input, '<unscripted>')
        return Effect.fail(
          new JobPermanent({
            reason: `HttpTest: no scripted response for ${request.method} ${request.url}`,
          }),
        )
      }
      if (!entry.repeat) pending.splice(at, 1)
      const body = entry.response.body
      const response: HttpResponse = {
        status: entry.response.status ?? 200,
        headers: lowerKeys(entry.response.headers),
        body:
          body === undefined
            ? ''
            : typeof body === 'string'
              ? body
              : JSON.stringify(body),
      }
      record(method, input, response)
      if (response.status === 429) {
        const seconds = Number(response.headers['retry-after'] ?? '60')
        return Effect.fail(
          new JobRateLimited({
            reason: `${request.url} is rate-limited`,
            retryAfterMs: (Number.isFinite(seconds) ? seconds : 60) * 1000,
          }),
        )
      }
      return Effect.succeed(response)
    })
  const layer = Layer.succeed(Http, {
    request: (request) => answer('request', request),
    // The scripted body as UTF-8 bytes, in one chunk.
    stream: (request) =>
      Effect.map(answer('stream', request), (response) => ({
        status: response.status,
        headers: response.headers,
        body: new Blob([response.body]).stream(),
      })),
  })
  return { layer, calls }
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

export type LogLine = {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
  readonly fields: LogFields
}

export const LogTest = (
  options: { readonly recorder?: Recorder } = {},
): TestPort<Log> & { readonly lines: ReadonlyArray<LogLine> } => {
  const { calls, record } = tap('Log', options.recorder)
  const lines: Array<LogLine> = []
  const line =
    (level: LogLine['level']) =>
    (message: string, fields: LogFields = {}) =>
      Effect.sync(() => {
        lines.push({ level, message, fields })
        record(level, { message, fields }, undefined)
      })
  const layer = Layer.succeed(Log, {
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
  })
  return { layer, calls, lines }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * One waiting batch, `batch-1`, landed exactly as the live port lands it
 * (`landImportGrid`): `rows` is what the import reader would see — a list
 * cell as its joined text, a malformed row with null cells and its reason.
 * A second `stage` writes nothing and answers with what is there, as the
 * live port does; a grid with no column or no placeable row fails
 * permanently.
 */
export const ImportTest = (
  options: { readonly recorder?: Recorder } = {},
): TestPort<Import> & {
  readonly rows: ReadonlyArray<LandedRow>
  readonly columns: ReadonlyArray<string>
} => {
  const { calls, record } = tap('Import', options.recorder)
  const rows: Array<LandedRow> = []
  const columns: Array<string> = []
  let landed: StageResult | null = null
  const layer = Layer.succeed(Import, {
    stage: (grid) =>
      Effect.suspend(() => {
        if (landed !== null)
          return Effect.succeed(record('stage', grid, landed))
        const read = landImportGrid(grid)
        if ('unreadable' in read || read.rows.length === 0) {
          const reason =
            'unreadable' in read
              ? read.unreadable
              : 'the grid has no row that could be placed'
          record('stage', grid, `<refused: ${reason}>`)
          return Effect.fail(new JobPermanent({ reason }))
        }
        rows.push(...read.rows)
        columns.push(...read.columns)
        landed = {
          batchId: 'batch-1',
          staged: read.rows.length,
          malformed: read.rows.flatMap((r) =>
            r.reason === null ? [] : [{ ordinal: r.rowNum, reason: r.reason }],
          ),
          refused: read.refused,
        }
        return Effect.succeed(record('stage', grid, landed))
      }),
  })
  return { layer, calls, rows, columns }
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/**
 * `brief` answers the brief seeded for that space id; any other id fails
 * permanently, as the live port does for a space it cannot hand over.
 */
export const SpacesTest = (
  options: {
    readonly briefs?: ReadonlyArray<SpaceBrief>
    readonly recorder?: Recorder
  } = {},
): TestPort<Spaces> => {
  const { calls, record } = tap('Spaces', options.recorder)
  const briefs = new Map((options.briefs ?? []).map((b) => [b.space.id, b]))
  const layer = Layer.succeed(Spaces, {
    brief: (spaceId) =>
      Effect.suspend(() => {
        const brief = briefs.get(spaceId)
        if (brief !== undefined)
          return Effect.succeed(record('brief', spaceId, brief))
        record('brief', spaceId, '<refused: no such space>')
        return Effect.fail(
          new JobPermanent({ reason: `Spaces.brief: no space ${spaceId}` }),
        )
      }),
  })
  return { layer, calls }
}

// ---------------------------------------------------------------------------
// All of them
// ---------------------------------------------------------------------------

export type TestPortsOptions = {
  readonly known?: { readonly [entityId: string]: IdentityKeys }
  readonly human?: { readonly [entityId: string]: JsonObject }
  /** The vocabulary keys `Facts.answer` treats as linked; absent, every key. */
  readonly linked?: ReadonlyArray<string>
  readonly entities?: ReadonlyArray<ReadEntity>
  readonly secret?: string
  readonly accessToken?: string
  readonly config?: JsonObject
  readonly http?: ReadonlyArray<HttpScript>
  readonly ai?: { readonly [L in AiLane]?: AiAnswer }
  readonly briefs?: ReadonlyArray<SpaceBrief>
}

/**
 * Every test port over one recorder: `layer` provides each but PluginDb and
 * Discover, `calls` is every port call in the order the job made it, and
 * each port's own handle is there for its extra state (`facts.values`,
 * `log.lines`).
 */
export const testPorts = (options: TestPortsOptions = {}) => {
  const recorder = makeRecorder()
  const identity = IdentityTest({
    ...(options.known ? { known: options.known } : {}),
    recorder,
  })
  const facts = FactsTest({
    ...(options.human ? { human: options.human } : {}),
    ...(options.linked ? { linked: options.linked } : {}),
    recorder,
  })
  const content = ContentTest({ recorder })
  const judgment = JudgmentTest({ recorder })
  const receipts = ReceiptsTest({ recorder })
  const read = ReadTest({
    ...(options.entities ? { entities: options.entities } : {}),
    recorder,
  })
  const secrets = SecretsTest({
    ...(options.secret === undefined ? {} : { secret: options.secret }),
    ...(options.accessToken === undefined
      ? {}
      : { accessToken: options.accessToken }),
    recorder,
  })
  const config = ConfigTest(options.config ?? {}, { recorder })
  const http = HttpTest(options.http ?? [], { recorder })
  const log = LogTest({ recorder })
  const importer = ImportTest({ recorder })
  const ai = AiTest({
    ...(options.ai === undefined ? {} : { answers: options.ai }),
    recorder,
  })
  const spaces = SpacesTest({
    ...(options.briefs === undefined ? {} : { briefs: options.briefs }),
    recorder,
  })
  return {
    layer: Layer.mergeAll(
      ai.layer,
      spaces.layer,
      importer.layer,
      identity.layer,
      facts.layer,
      content.layer,
      judgment.layer,
      receipts.layer,
      read.layer,
      secrets.layer,
      config.layer,
      http.layer,
      log.layer,
    ),
    calls: recorder.calls,
    identity,
    facts,
    content,
    judgment,
    receipts,
    read,
    secrets,
    config,
    http,
    log,
    import: importer,
    ai,
    spaces,
  }
}

// ---------------------------------------------------------------------------
// Storage sources — a fake Drive and the read half's conformance suite
// ---------------------------------------------------------------------------

export {
  makeFakeDrive,
  FAKE_DRIVE_SEED,
  FAKE_DRIVE_FIXTURE,
  FAKE_DRIVE_CREDENTIALS,
  GOOGLE_DOC_MIME,
  DOCX_MIME,
} from './fake-drive.ts'
export type {
  FakeDrive,
  FakeDriveSeedItem,
  FakeDriveCredentials,
} from './fake-drive.ts'
export {
  storageSourceConformance,
  ConformanceFailure,
  sha256Hex,
} from './storage-source-conformance.ts'
export type {
  StorageSourceFixture,
  StorageSourceSubject,
  ConformanceCase,
} from './storage-source-conformance.ts'

// The chaos list — the read half's bad days, as cases beside the happy path
export {
  FAKE_DRIVE_SCAN,
  FAKE_DRIVE_CHAOS_FIXTURE,
  fakeDriveLargeChunks,
} from './fake-drive.ts'
export type { FakeDriveLargeFile } from './fake-drive.ts'
export {
  storageSourceChaos,
  LARGE_FILE_MEMORY_BOUND,
  makeSha256,
} from './storage-source-conformance.ts'
export type {
  StorageSourceChaos,
  StorageSourceChaosFixture,
  StorageSourceChaosSubject,
} from './storage-source-conformance.ts'

// The write half — ensureFolder, putFile, move, rename
export { FAKE_DRIVE_WRITE_FIXTURE } from './fake-drive.ts'
export type { FakeDriveCreate, FakeDriveFields } from './fake-drive.ts'
export { storageSourceWriteConformance } from './storage-source-conformance.ts'
export type {
  StorageSourceWriteFixture,
  StorageSourceWriteSubject,
} from './storage-source-conformance.ts'

// Drive's REST API over the fake Drive, and an Http port over a fetch
export {
  makeFakeDriveApi,
  HttpFetchTest,
  DRIVE_API,
  DRIVE_UPLOAD_API,
  DRIVE_FOLDER_MIME,
  RESUMABLE_CHUNK_MULTIPLE,
} from './fake-drive-api.ts'
export type {
  FakeDriveApi,
  FakeDriveApiOptions,
  DriveApiRequest,
  FetchLike,
} from './fake-drive-api.ts'
