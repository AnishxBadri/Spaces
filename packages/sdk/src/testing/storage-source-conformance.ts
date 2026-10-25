import { Effect, Exit, Schema } from 'effect'
import type {
  StorageEntry,
  StorageSource,
  StorageSourceError,
  StorageUpload,
  WritableStorageSource,
} from '../storage-source.ts'

/**
 * The read half's happy-path conformance suite: what every storage-source
 * provider must do to ship. Test-runner agnostic — it returns cases, and a
 * provider's test file runs each one:
 *
 *   it.each(storageSourceConformance(subject))('$name', ({ run }) => Effect.runPromise(run))
 *
 * - Each case builds a fresh source with `subject.make()`.
 * - A fixture expectation that the provider's tree does not meet fails the
 *   case; nothing is skipped for being absent.
 */

/** A conformance assertion that did not hold. */
export class ConformanceFailure extends Schema.TaggedError<ConformanceFailure>()(
  'ConformanceFailure',
  { message: Schema.String },
) {}

/** What the provider's seeded tree holds, written independently of the seed. */
export type StorageSourceFixture = {
  /** A folder with more than two direct children, so a page size of 2 pages. */
  readonly dataRoom: {
    readonly folderId: string
    readonly link: string
    readonly childIds: ReadonlyArray<string>
  }
  /** A native document in `folderId`, read as its export. */
  readonly nativeDoc: {
    readonly fileId: string
    readonly folderId: string
    readonly link: string
    readonly exportMime: string
  }
  /** Folders and their ancestor ids, drive root first. At least one is required. */
  readonly ancestry: ReadonlyArray<{
    readonly folderId: string
    readonly ancestorIds: ReadonlyArray<string>
  }>
  /** A URL that is not this provider's: resolves to null. */
  readonly foreignLink: string
  /** An id the provider has never seen: `NotFound`. */
  readonly missingId: string
}

export type StorageSourceSubject = {
  readonly make: () => StorageSource
  readonly fixture: StorageSourceFixture
  /** Strings that must never reach the picker config — the client secret, the refresh token. */
  readonly secrets: ReadonlyArray<string>
}

export type ConformanceCase = {
  readonly name: string
  readonly run: Effect.Effect<void, ConformanceFailure | StorageSourceError>
}

const check = (
  holds: boolean,
  message: string,
): Effect.Effect<void, ConformanceFailure> =>
  holds ? Effect.void : Effect.fail(new ConformanceFailure({ message }))

const show = (value: unknown) => JSON.stringify(value)

/** Keys that would mean a provider hash is being reported as ours. */
const HASH_KEY = /hash|checksum|md5|sha/i

const noHashKey = (where: string, value: object) => {
  const found = Object.keys(value).filter((k) => HASH_KEY.test(k))
  return check(
    found.length === 0,
    `${where} carries ${found.join(', ')} — bytes are hashed by core on arrival, and a provider hash is never reported as ours`,
  )
}

const checkEntry = Effect.fn('checkEntry')(function* (
  entry: StorageEntry,
  folderId: string,
) {
  yield* noHashKey(`entry ${entry.id}`, entry)
  yield* check(
    entry.parentId === folderId,
    `entry ${entry.id} listed in ${folderId} says its parent is ${show(entry.parentId)}`,
  )
  yield* check(
    entry.changeToken.length > 0,
    `entry ${entry.id} has an empty changeToken`,
  )
  yield* check(
    !Number.isNaN(Date.parse(entry.modifiedAt)),
    `entry ${entry.id} modifiedAt ${show(entry.modifiedAt)} is not a timestamp`,
  )
})

/** Every page of a folder at `pageSize`, in order. */
const allPages = Effect.fn('allPages')(function* (
  source: StorageSource,
  folderId: string,
  pageSize: number,
) {
  const pages: Array<ReadonlyArray<StorageEntry>> = []
  let cursor: string | undefined
  do {
    const page = yield* source.listFolder(
      folderId,
      cursor === undefined ? { pageSize } : { pageSize, cursor },
    )
    pages.push(page.entries)
    yield* check(
      pages.length <= 1000,
      `listFolder(${folderId}) never ended — 1000 pages`,
    )
    cursor = page.next
  } while (cursor !== undefined)
  return pages
})

const readAll = (stream: ReadableStream<Uint8Array>) =>
  Effect.promise(async () => {
    const reader = stream.getReader()
    const chunks: Array<Uint8Array> = []
    let length = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      length += value.byteLength
    }
    const bytes = new Uint8Array(length)
    let at = 0
    for (const chunk of chunks) {
      bytes.set(chunk, at)
      at += chunk.byteLength
    }
    return bytes
  })

/** Our hash: SHA-256 of the bytes as they arrived, lowercase hex. */
export const sha256Hex = (bytes: Uint8Array) =>
  Effect.promise(async () =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())),
      (b) => b.toString(16).padStart(2, '0'),
    ).join(''),
  )

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const OOXML = 'application/vnd.openxmlformats-officedocument.'

/** Whether a value is JSON as it stands: no undefined, function, class instance or non-finite number. */
const jsonProblem = (value: unknown, path: string): string | null => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return null
  if (typeof value === 'number')
    return Number.isFinite(value) ? null : `${path} is ${value}`
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const problem = jsonProblem(v, `${path}[${i}]`)
      if (problem) return problem
    }
    return null
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null)
      return `${path} is not a plain object`
    for (const [k, v] of Object.entries(value)) {
      const problem = jsonProblem(v, `${path}.${k}`)
      if (problem) return problem
    }
    return null
  }
  return `${path} is a ${typeof value}`
}

/** Every key, at any depth, of a JSON value. */
const keysOf = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
      : []

export const storageSourceConformance = (
  subject: StorageSourceSubject,
): ReadonlyArray<ConformanceCase> => {
  const { fixture } = subject
  const fresh = (
    body: (
      source: StorageSource,
    ) => Effect.Effect<unknown, ConformanceFailure | StorageSourceError>,
  ): ConformanceCase['run'] =>
    Effect.suspend(() => body(subject.make())).pipe(Effect.asVoid)

  return [
    {
      name: 'resolveLink names the folder and the file a link points at, and null for a foreign link',
      run: fresh((source) =>
        Effect.gen(function* () {
          const folder = yield* source.resolveLink(fixture.dataRoom.link)
          yield* check(
            show(folder) === show({ folderId: fixture.dataRoom.folderId }),
            `resolveLink(${fixture.dataRoom.link}) gave ${show(folder)}`,
          )
          const file = yield* source.resolveLink(fixture.nativeDoc.link)
          yield* check(
            show(file) === show({ fileId: fixture.nativeDoc.fileId }),
            `resolveLink(${fixture.nativeDoc.link}) gave ${show(file)}`,
          )
          const foreign = yield* source.resolveLink(fixture.foreignLink)
          yield* check(
            foreign === null,
            `resolveLink(${fixture.foreignLink}) gave ${show(foreign)}, not null`,
          )
        }),
      ),
    },
    {
      name: 'listFolder at a page size of 2 returns every seeded entry exactly once across cursors',
      run: fresh((source) =>
        Effect.gen(function* () {
          const { folderId, childIds } = fixture.dataRoom
          yield* check(
            childIds.length > 2,
            `the fixture's data room lists ${childIds.length} children; more than 2 are needed to page at 2`,
          )
          const pages = yield* allPages(source, folderId, 2)
          for (const [i, page] of pages.entries())
            yield* check(
              page.length <= 2 && (page.length > 0 || pages.length === 1),
              `page ${i} of ${folderId} holds ${page.length} entries at a page size of 2`,
            )
          const seen = pages.flat()
          for (const entry of seen) yield* checkEntry(entry, folderId)
          const ids = seen.map((e) => e.id)
          const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
          yield* check(
            duplicates.length === 0,
            `listFolder(${folderId}) returned ${duplicates.join(', ')} more than once`,
          )
          const missing = childIds.filter((id) => !ids.includes(id))
          yield* check(
            missing.length === 0,
            `listFolder(${folderId}) never returned ${missing.join(', ')}`,
          )
          const extra = ids.filter((id) => !childIds.includes(id))
          yield* check(
            extra.length === 0,
            `listFolder(${folderId}) returned ${extra.join(', ')}, which the fixture does not seed`,
          )
        }),
      ),
    },
    {
      name: 'getFile on the native doc yields exported bytes and a mime, hashed here and not by the provider',
      run: fresh((source) =>
        Effect.gen(function* () {
          const { fileId, folderId, exportMime } = fixture.nativeDoc
          const listed = (yield* allPages(source, folderId, 100))
            .flat()
            .find((e) => e.id === fileId)
          if (listed === undefined)
            return yield* new ConformanceFailure({
              message: `native doc ${fileId} is not listed in ${folderId}`,
            })
          yield* noHashKey(`entry ${fileId}`, listed)
          yield* check(
            listed.mime !== exportMime,
            `native doc ${fileId} lists as ${listed.mime}, its export mime — it is not native`,
          )
          const file = yield* source.getFile(fileId)
          yield* noHashKey(`getFile(${fileId})`, file)
          yield* check(
            file.mime === exportMime,
            `getFile(${fileId}) gave mime ${file.mime}, not ${exportMime}`,
          )
          yield* check(file.name.length > 0, `getFile(${fileId}) has no name`)
          const bytes = yield* readAll(file.stream)
          yield* check(
            bytes.byteLength > 0,
            `getFile(${fileId}) streamed no bytes`,
          )
          if (exportMime.startsWith(OOXML))
            yield* check(
              ZIP_MAGIC.every((b, i) => bytes[i] === b),
              `getFile(${fileId}) is ${exportMime} but its bytes are not a zip`,
            )
          const ours = yield* sha256Hex(bytes)
          yield* check(
            /^[0-9a-f]{64}$/.test(ours),
            `SHA-256 of ${fileId} came out as ${ours}`,
          )
        }),
      ),
    },
    {
      name: 'getFolder returns the ancestor chain up to the drive root',
      run: fresh((source) =>
        Effect.gen(function* () {
          yield* check(
            fixture.ancestry.length > 0,
            'the fixture names no folder ancestry to check',
          )
          for (const { folderId, ancestorIds } of fixture.ancestry) {
            const folder = yield* source.getFolder(folderId)
            yield* noHashKey(`getFolder(${folderId})`, folder)
            yield* check(
              folder.id === folderId && folder.name.length > 0,
              `getFolder(${folderId}) gave ${show({ id: folder.id, name: folder.name })}`,
            )
            const got = folder.parents.map((p) => p.id)
            yield* check(
              show(got) === show(ancestorIds),
              `getFolder(${folderId}) ancestry is ${show(got)}, expected ${show(ancestorIds)} (root first)`,
            )
            const root = folder.parents.at(0)
            if (root !== undefined) {
              const top = yield* source.getFolder(root.id)
              yield* check(
                top.parents.length === 0,
                `${root.id} heads ${folderId}'s ancestry but has parents ${show(top.parents)}`,
              )
            }
          }
        }),
      ),
    },
    {
      name: 'a missing id is NotFound, typed — not a throw',
      run: fresh((source) =>
        Effect.gen(function* () {
          const id = fixture.missingId
          const outcome = (
            attempt: Effect.Effect<unknown, StorageSourceError>,
          ) =>
            Effect.match(attempt, {
              onSuccess: () => 'succeeded',
              onFailure: (e) =>
                e._tag !== 'NotFound'
                  ? e._tag
                  : e.id === id
                    ? 'NotFound'
                    : `NotFound(${e.id})`,
            })
          const attempts: ReadonlyArray<
            readonly [string, Effect.Effect<string>]
          > = [
            ['getFile', outcome(source.getFile(id))],
            ['getFolder', outcome(source.getFolder(id))],
            ['listFolder', outcome(source.listFolder(id))],
          ]
          for (const [method, attempt] of attempts) {
            const result = yield* attempt
            yield* check(
              result === 'NotFound',
              `${method}(${id}) ${result === 'succeeded' ? 'succeeded' : `failed ${result}`}, expected NotFound`,
            )
          }
        }),
      ),
    },
    {
      name: 'changes(null) hands a starting cursor, and the cursor reads back',
      run: fresh((source) =>
        Effect.gen(function* () {
          const start = yield* source.changes(null)
          yield* check(
            start.changes.length === 0 && start.next.length > 0,
            `changes(null) gave ${start.changes.length} changes and cursor ${show(start.next)}`,
          )
          const next = yield* source.changes(start.next)
          yield* check(
            next.next.length > 0,
            `changes(${start.next}) gave no next cursor`,
          )
          for (const change of next.changes)
            if (change._tag === 'changed')
              yield* noHashKey(`change ${change.entry.id}`, change.entry)
        }),
      ),
    },
    {
      name: 'pickerConfig is plain JSON and holds no client secret or refresh token',
      run: fresh((source) =>
        Effect.gen(function* () {
          const config = yield* source.pickerConfig()
          const problem = jsonProblem(config, 'pickerConfig')
          yield* check(problem === null, `${problem} — it must be JSON`)
          const keys = keysOf(config).filter((k) => /secret|refresh/i.test(k))
          yield* check(
            keys.length === 0,
            `pickerConfig carries ${keys.join(', ')}`,
          )
          yield* check(
            subject.secrets.length > 0,
            'the subject names no secrets to look for',
          )
          const text = JSON.stringify(config)
          const leaked = subject.secrets.filter((s) => text.includes(s))
          yield* check(
            leaked.length === 0,
            `pickerConfig reaches ${leaked.length} of the connection's secrets`,
          )
        }),
      ),
    },
  ]
}

// ---------------------------------------------------------------------------
// The chaos list — the bad days every provider is measured against
// ---------------------------------------------------------------------------

/**
 * How a test flips a provider's bad days. The fake Drive is one (`chaos`);
 * a real plugin's test implements it over its HTTP fake.
 *
 * - `rateLimit`: the next `calls` requests answer 429 with `Retry-After` of
 *   `retryAfterMs`.
 * - `evictCursors`: every change cursor handed out so far is forgotten (Drive's 410).
 * - `vanish`: the item is deleted right after the next listing that shows it.
 * - `revoke` / `restore`: the connection's token is refused, then honoured again.
 */
export type StorageSourceChaos = {
  readonly rateLimit: (calls: number, retryAfterMs: number) => void
  readonly evictCursors: () => void
  readonly vanish: (id: string) => void
  readonly revoke: () => void
  readonly restore: () => void
}

/** The happy-path fixture plus what the chaos cases need of the same tree. */
export type StorageSourceChaosFixture = StorageSourceFixture & {
  /** A plain file (not the native doc) among `dataRoom.childIds`, with other files beside it. */
  readonly vanishingFileId: string
  /** A file large enough that buffering it whole would show, and its SHA-256. */
  readonly largeFile: {
    readonly fileId: string
    readonly size: number
    readonly sha256: string
  }
}

/**
 * A provider with its bad-day handle. `make` hands both back together, so a
 * subject built for `storageSourceConformance` cannot be run here by accident.
 */
export type StorageSourceChaosSubject = {
  readonly make: () => {
    readonly source: StorageSource
    readonly chaos: StorageSourceChaos
  }
  readonly fixture: StorageSourceChaosFixture
  /** Strings that must never appear in a failure — the client secret, the refresh token. */
  readonly secrets: ReadonlyArray<string>
  /** Bytes the process holds now; under node, `() => process.memoryUsage.rss()`. */
  readonly memory: () => number
}

/**
 * How far memory may rise over the start while the large file streams.
 * - Read chunks are garbage until V8 collects them, which it does late:
 *   16 KiB chunks peaked near 50 MB cold, 1 MiB chunks near 100 MB.
 * - Under half of a 200 MB file, so holding it whole always fails.
 */
export const LARGE_FILE_MEMORY_BOUND = 96 * 1024 * 1024

const MB = 1024 * 1024

type Outcome<TValue, TError> =
  | { readonly _tag: 'ok'; readonly value: TValue }
  | { readonly _tag: 'failed'; readonly error: TError }
  | { readonly _tag: 'died'; readonly defect: string }

/** How an effect ended, a defect (a throw, a rejected promise) told apart from a typed failure. */
const outcomeOf = <TValue, TError>(
  effect: Effect.Effect<TValue, TError>,
): Effect.Effect<Outcome<TValue, TError>> =>
  Effect.map(Effect.exit(effect), (exit): Outcome<TValue, TError> => {
    if (Exit.isSuccess(exit)) return { _tag: 'ok', value: exit.value }
    for (const reason of exit.cause.reasons)
      if (reason._tag === 'Fail') return { _tag: 'failed', error: reason.error }
    const die = exit.cause.reasons.find((r) => r._tag === 'Die')
    return {
      _tag: 'died',
      defect: die === undefined ? 'interrupted' : String(die.defect),
    }
  })

const told = <TValue, TError extends { readonly _tag: string }>(
  outcome: Outcome<TValue, TError>,
) =>
  outcome._tag === 'ok'
    ? 'succeeded'
    : outcome._tag === 'failed'
      ? `failed ${outcome.error._tag}`
      : `died (${outcome.defect}) — a throw, not a typed failure`

/** The typed failure `tag` from `effect`, or a ConformanceFailure saying what happened instead. */
const expectTyped = <
  TValue,
  TError extends StorageSourceError,
  TTag extends TError['_tag'],
>(
  label: string,
  effect: Effect.Effect<TValue, TError>,
  tag: TTag,
): Effect.Effect<
  Extract<TError, { readonly _tag: TTag }>,
  ConformanceFailure
> =>
  Effect.flatMap(outcomeOf(effect), (outcome) => {
    const isTag = (e: TError): e is Extract<TError, { readonly _tag: TTag }> =>
      e._tag === tag
    return outcome._tag === 'failed' && isTag(outcome.error)
      ? Effect.succeed(outcome.error)
      : Effect.fail(
          new ConformanceFailure({
            message: `${label} ${told(outcome)}, expected ${tag}`,
          }),
        )
  })

/** Reads a stream to its end, keeping nothing: counts, and each chunk handed to `onChunk`. */
const drain = (
  label: string,
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void = () => {},
) =>
  Effect.tryPromise({
    try: async () => {
      const reader = stream.getReader()
      let bytes = 0
      let chunks = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return { bytes, chunks }
        bytes += value.byteLength
        chunks += 1
        onChunk(value)
      }
    },
    catch: (e) =>
      new ConformanceFailure({
        message: `${label}'s stream errored: ${String(e)}`,
      }),
  })

/** JSON with sorted keys: two plain values deep-equal exactly when these match. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : typeof value === 'object' && value !== null
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(',')}}`
      : String(JSON.stringify(value))

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/**
 * SHA-256 fed a chunk at a time — what core does to bytes on arrival.
 * WebCrypto digests only a whole buffer, and the kit reaches no node API.
 */
export const makeSha256 = () => {
  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  const block = new Uint8Array(64)
  let held = 0
  let total = 0

  const blockView = new DataView(block.buffer)

  const compress = (view: DataView, at: number) => {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(at + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = w[i - 16] + s0 + w[i - 7] + s1
    }
    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let k = h[7]
    for (let i = 0; i < 64; i += 1) {
      const t1 =
        (k +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          SHA256_K[i] +
          w[i]) |
        0
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0
      k = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = h[0] + a
    h[1] = h[1] + b
    h[2] = h[2] + c
    h[3] = h[3] + d
    h[4] = h[4] + e
    h[5] = h[5] + f
    h[6] = h[6] + g
    h[7] = h[7] + k
  }

  const update = (bytes: Uint8Array) => {
    total += bytes.byteLength
    let at = 0
    if (held > 0) {
      const take = Math.min(64 - held, bytes.byteLength)
      block.set(bytes.subarray(0, take), held)
      held += take
      at = take
      if (held < 64) return
      compress(blockView, 0)
      held = 0
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (; at + 64 <= bytes.byteLength; at += 64) compress(view, at)
    block.set(bytes.subarray(at), 0)
    held = bytes.byteLength - at
  }

  /** The digest as lowercase hex. Call once: it consumes the hasher. */
  const hex = () => {
    const bits = total * 8
    const tail = new Uint8Array(held < 56 ? 64 : 128)
    tail.set(block.subarray(0, held))
    tail[held] = 0x80
    const view = new DataView(tail.buffer)
    view.setUint32(tail.byteLength - 8, Math.floor(bits / 0x100000000))
    view.setUint32(tail.byteLength - 4, bits >>> 0)
    for (let at = 0; at < tail.byteLength; at += 64) compress(view, at)
    return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('')
  }

  return { update, hex }
}

/**
 * The chaos list as cases, the same
 * shape as `storageSourceConformance`, so a provider's test runs both.
 *
 * - Each bad day must surface as its typed failure: a throw or a rejected
 *   promise fails the case as loudly as a wrong tag.
 * - The large-file case reads `fixture.largeFile` whole; give it a generous
 *   timeout in the runner.
 */
export const storageSourceChaos = (
  subject: StorageSourceChaosSubject,
): ReadonlyArray<ConformanceCase> => {
  const { fixture } = subject
  const fresh = (
    body: (
      made: ReturnType<StorageSourceChaosSubject['make']>,
    ) => Effect.Effect<unknown, ConformanceFailure | StorageSourceError>,
  ): ConformanceCase['run'] =>
    Effect.suspend(() => body(subject.make())).pipe(Effect.asVoid)
  const { folderId } = fixture.dataRoom
  const gone = fixture.vanishingFileId

  /** The data room listed in full — after which a `vanish(gone)` has taken effect. */
  const listDataRoom = Effect.fn('listDataRoom')(function* (
    source: StorageSource,
  ) {
    const entries = (yield* allPages(source, folderId, 100)).flat()
    yield* check(
      entries.some((e) => e.id === gone),
      `listFolder(${folderId}) did not show ${gone} before it was deleted`,
    )
    return entries
  })

  const { largeFile } = fixture
  const largeMb = Math.round(largeFile.size / MB)
  const boundMb = LARGE_FILE_MEMORY_BOUND / MB

  return [
    {
      name: 'a 429 with Retry-After: 1 is RateLimited carrying 1000 ms, and a retry after waiting it succeeds',
      run: fresh(({ source, chaos }) =>
        Effect.gen(function* () {
          chaos.rateLimit(1, 1000)
          const limited = yield* expectTyped(
            `getFolder(${folderId}) after a seeded 429 with Retry-After: 1`,
            source.getFolder(folderId),
            'RateLimited',
          )
          yield* check(
            limited.retryAfterMs === 1000,
            `RateLimited carried retryAfterMs ${limited.retryAfterMs}, not the 1000 that Retry-After: 1 gave`,
          )
          yield* Effect.sleep(limited.retryAfterMs)
          const folder = yield* outcomeOf(source.getFolder(folderId))
          yield* check(
            folder._tag === 'ok' && folder.value.id === folderId,
            `getFolder(${folderId}) retried after the ${limited.retryAfterMs} ms hint ${told(folder)}`,
          )
        }),
      ),
    },
    {
      name: 'a file deleted between list and get is NotFound, typed — not a rejected promise',
      run: fresh(({ source, chaos }) =>
        Effect.gen(function* () {
          chaos.vanish(gone)
          yield* listDataRoom(source)
          const missing = yield* expectTyped(
            `getFile(${gone}) deleted after it was listed`,
            source.getFile(gone),
            'NotFound',
          )
          yield* check(
            missing.id === gone,
            `getFile(${gone}) failed NotFound naming ${show(missing.id)}`,
          )
        }),
      ),
    },
    {
      name: 'half a batch failing loses nothing: every other listed file reads, the vanished one alone is NotFound',
      run: fresh(({ source, chaos }) =>
        Effect.gen(function* () {
          chaos.vanish(gone)
          const files = (yield* listDataRoom(source)).filter(
            (e) => e.kind === 'file',
          )
          yield* check(
            files.length > 1,
            `${folderId} lists ${files.length} file(s); a batch needs ${gone} and at least one other`,
          )
          const problems: Array<string> = []
          for (const entry of files) {
            const read = yield* outcomeOf(
              Effect.flatMap(source.getFile(entry.id), (file) =>
                drain(`getFile(${entry.id})`, file.stream),
              ),
            )
            if (entry.id === gone) {
              const typed =
                read._tag === 'failed' &&
                read.error._tag === 'NotFound' &&
                read.error.id === gone
              if (!typed)
                problems.push(
                  `getFile(${gone}) ${told(read)}, expected NotFound(${gone})`,
                )
            } else if (read._tag !== 'ok') {
              problems.push(`getFile(${entry.id}) ${told(read)}`)
            } else if (read.value.bytes === 0) {
              problems.push(`getFile(${entry.id}) streamed no bytes`)
            }
          }
          yield* check(
            problems.length === 0,
            `with ${gone} deleted mid-batch: ${problems.join('; ')}`,
          )
        }),
      ),
    },
    {
      name: 'a cursor the provider has forgotten is CursorExpired naming it, and a fresh cursor reads',
      run: fresh(({ source, chaos }) =>
        Effect.gen(function* () {
          const start = yield* source.changes(null)
          chaos.evictCursors()
          const expired = yield* expectTyped(
            `changes(${start.next}) after the provider forgot it`,
            source.changes(start.next),
            'CursorExpired',
          )
          yield* check(
            expired.cursor === start.next,
            `CursorExpired named ${show(expired.cursor)}, not ${show(start.next)}`,
          )
          const again = yield* source.changes(null)
          const read = yield* outcomeOf(source.changes(again.next))
          yield* check(
            read._tag === 'ok',
            `changes(${again.next}), a cursor handed out after the eviction, ${told(read)}`,
          )
        }),
      ),
    },
    {
      name: 'a page of changes replayed from the same cursor is the same result both times',
      run: fresh(({ source, chaos }) =>
        Effect.gen(function* () {
          const start = yield* source.changes(null)
          chaos.vanish(gone)
          yield* listDataRoom(source)
          const first = yield* source.changes(start.next)
          const second = yield* source.changes(start.next)
          yield* check(
            first.changes.some((c) => c._tag === 'removed' && c.id === gone),
            `changes(${start.next}) did not report ${gone}'s removal: ${show(first.changes)}`,
          )
          yield* check(
            canonical(first) === canonical(second),
            `changes(${start.next}) gave ${show(first)}, then ${show(second)} replayed`,
          )
        }),
      ),
    },
    {
      name: 'a token revoked mid-run fails every read AuthExpired without a secret in it, and restore brings it back',
      run: fresh(({ source, chaos }) =>
        Effect.gen(function* () {
          yield* source.listFolder(folderId)
          chaos.revoke()
          const attempts: ReadonlyArray<
            readonly [string, Effect.Effect<unknown, StorageSourceError>]
          > = [
            ['resolveLink', source.resolveLink(fixture.dataRoom.link)],
            ['listFolder', source.listFolder(folderId)],
            ['getFolder', source.getFolder(folderId)],
            ['getFile', source.getFile(fixture.nativeDoc.fileId)],
            ['changes', source.changes(null)],
            ['pickerConfig', source.pickerConfig()],
          ]
          for (const [method, attempt] of attempts) {
            const expired = yield* expectTyped(
              `${method} with the token revoked`,
              attempt,
              'AuthExpired',
            )
            const text = `${String(expired)} ${JSON.stringify(expired)}`
            const leaked = subject.secrets.filter((s) => text.includes(s))
            yield* check(
              leaked.length === 0,
              `${method}'s AuthExpired carries ${leaked.length} of the connection's secrets`,
            )
          }
          chaos.restore()
          const back = yield* outcomeOf(source.listFolder(folderId))
          yield* check(
            back._tag === 'ok',
            `listFolder(${folderId}) after restore ${told(back)}`,
          )
        }),
      ),
    },
    {
      name: `getFile streams a ${largeMb} MB file chunk by chunk, hashed as it arrives, peak memory within ${boundMb} MB of the start`,
      run: fresh(({ source }) =>
        Effect.gen(function* () {
          const { fileId, size, sha256 } = largeFile
          yield* check(
            size >= 2 * LARGE_FILE_MEMORY_BOUND,
            `the fixture's large file is ${largeMb} MB; under ${2 * boundMb} MB, buffering it would not show`,
          )
          const before = subject.memory()
          let peak = 0
          const hash = makeSha256()
          const file = yield* source.getFile(fileId)
          const read = yield* drain(
            `getFile(${fileId})`,
            file.stream,
            (chunk) => {
              hash.update(chunk)
              peak = Math.max(peak, subject.memory() - before)
            },
          )
          yield* check(
            read.bytes === size,
            `getFile(${fileId}) streamed ${read.bytes} bytes, not ${size}`,
          )
          yield* check(
            read.chunks > 1,
            `getFile(${fileId}) arrived as one ${largeMb} MB chunk — it was buffered`,
          )
          yield* check(
            peak <= LARGE_FILE_MEMORY_BOUND,
            `memory rose ${Math.round(peak / MB)} MB while ${fileId} streamed, over the ${boundMb} MB bound — the file was buffered`,
          )
          const ours = hash.hex()
          yield* check(
            ours === sha256,
            `SHA-256 of the streamed ${fileId} is ${ours}, not ${sha256}`,
          )
        }),
      ),
    },
  ]
}

// ---------------------------------------------------------------------------
// The write half — ensureFolder, putFile, move, rename
// ---------------------------------------------------------------------------

/** Where the write suite may write, written independently of the seed. */
export type StorageSourceWriteFixture = {
  /** A folder holding nothing named `A`, `Puts`, `Moves` or `Renames`. */
  readonly rootId: string
  /** An id the provider has never seen: `NotFound`. */
  readonly missingId: string
}

export type StorageSourceWriteSubject = {
  readonly make: () => WritableStorageSource
  readonly fixture: StorageSourceWriteFixture
}

const DOCX = `${OOXML}wordprocessingml.document`

const textEncoder = new TextEncoder()

/** An upload of `content` with the SHA-256 core would have computed, streamed in two chunks. */
const uploadOf = Effect.fn('uploadOf')(function* (
  content: string | Uint8Array,
  mime = 'application/pdf',
) {
  const bytes =
    typeof content === 'string' ? textEncoder.encode(content) : content
  const sha256 = yield* sha256Hex(bytes)
  const half = Math.ceil(bytes.byteLength / 2)
  const upload: StorageUpload = {
    mime,
    sha256,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, half))
        if (half < bytes.byteLength) controller.enqueue(bytes.slice(half))
        controller.close()
      },
    }),
  }
  return upload
})

/** A folder's whole listing. */
const listed = Effect.fn('listed')(function* (
  source: StorageSource,
  folderId: string,
) {
  return (yield* allPages(source, folderId, 100)).flat()
})

/** The one entry named `name` in a folder; none or several fails. */
const onlyNamed = Effect.fn('onlyNamed')(function* (
  source: StorageSource,
  folderId: string,
  name: string,
  kind: StorageEntry['kind'],
) {
  const found = (yield* listed(source, folderId)).filter(
    (e) => e.name === name && e.kind === kind,
  )
  const only = found.at(0)
  if (found.length !== 1 || only === undefined)
    return yield* new ConformanceFailure({
      message: `${folderId} holds ${found.length} ${kind}s named ${show(name)}${found.length > 1 ? ` (${found.map((e) => e.id).join(', ')}) — the tree forked` : ''}, expected one`,
    })
  return only
})

/** A file's mime and the SHA-256 of its bytes, as `getFile` streams them. */
const readBack = Effect.fn('readBack')(function* (
  source: StorageSource,
  fileId: string,
) {
  const file = yield* source.getFile(fileId)
  const bytes = yield* readAll(file.stream)
  return { mime: file.mime, sha256: yield* sha256Hex(bytes) }
})

/**
 * The write half's suite, the
 * same shape as `storageSourceConformance`.
 *
 * - `ensureFolder` is run four at once: Drive permits duplicate folder
 *   names, so a provider that looks and then creates forks the tree.
 * - A replayed `move` or `rename` must change nothing: the same
 *   `changeToken`, and no change in the feed.
 */
export const storageSourceWriteConformance = (
  subject: StorageSourceWriteSubject,
): ReadonlyArray<ConformanceCase> => {
  const { rootId, missingId } = subject.fixture
  const fresh = (
    body: (
      source: WritableStorageSource,
    ) => Effect.Effect<unknown, ConformanceFailure | StorageSourceError>,
  ): ConformanceCase['run'] =>
    Effect.suspend(() => body(subject.make())).pipe(Effect.asVoid)

  const absent = Effect.fn('absent')(function* (
    source: StorageSource,
    name: string,
  ) {
    const before = (yield* listed(source, rootId)).filter(
      (e) => e.name === name,
    )
    yield* check(
      before.length === 0,
      `the fixture's root ${rootId} already holds ${show(name)}`,
    )
  })

  /** A new folder under the root for one case, so a case reads only its own writes. */
  const scratch = Effect.fn('scratch')(function* (
    source: WritableStorageSource,
    name: string,
  ) {
    yield* absent(source, name)
    return yield* source.ensureFolder(rootId, name)
  })

  const entryIn = Effect.fn('entryIn')(function* (
    source: StorageSource,
    folderId: string,
    id: string,
  ) {
    const entry = (yield* listed(source, folderId)).find((e) => e.id === id)
    if (entry === undefined)
      return yield* new ConformanceFailure({
        message: `${id} is not listed in ${folderId}`,
      })
    return entry
  })

  const quietSince = Effect.fn('quietSince')(function* (
    source: StorageSource,
    cursor: string,
    id: string,
    label: string,
  ) {
    const page = yield* source.changes(cursor)
    const touched = page.changes.filter(
      (c) => (c._tag === 'changed' ? c.entry.id : c.id) === id,
    )
    yield* check(
      touched.length === 0,
      `${label} replayed reported ${show(touched)} — a replay is a no-op`,
    )
  })

  return [
    {
      name: 'ensureFolder(A/B/C) twice yields one chain of folders and the same id both times',
      run: fresh((source) =>
        Effect.gen(function* () {
          yield* absent(source, 'A')
          const first = yield* source.ensureFolder(rootId, 'A/B/C')
          const second = yield* source.ensureFolder(rootId, 'A/B/C')
          const spelled = yield* source.ensureFolder(rootId, '/A//B/C/')
          yield* check(
            first === second && second === spelled,
            `ensureFolder(A/B/C) gave ${show([first, second])}, and ${show(spelled)} for /A//B/C/`,
          )
          const a = yield* onlyNamed(source, rootId, 'A', 'folder')
          const b = yield* onlyNamed(source, a.id, 'B', 'folder')
          const c = yield* onlyNamed(source, b.id, 'C', 'folder')
          yield* check(
            c.id === first,
            `ensureFolder(A/B/C) gave ${first}, but A/B/C is ${c.id}`,
          )
          const below = [
            ...(yield* listed(source, a.id)),
            ...(yield* listed(source, b.id)),
            ...(yield* listed(source, c.id)),
          ]
          yield* check(
            below.length === 2,
            `A holds ${show(below.map((e) => e.name))} below it, expected B and C alone`,
          )
          const folder = yield* source.getFolder(first)
          const chain = folder.parents.slice(-2).map((p) => p.name)
          yield* check(
            show(chain) === show(['A', 'B']) &&
              folder.parents.some((p) => p.id === rootId),
            `getFolder(${first}) ancestry is ${show(folder.parents)}, expected ${rootId} then A, B`,
          )
        }),
      ),
    },
    {
      name: 'four concurrent ensureFolder(A/B) calls yield exactly one B folder and one id — the duplicate-name trap',
      run: fresh((source) =>
        Effect.gen(function* () {
          yield* absent(source, 'A')
          const ids = yield* Effect.all(
            Array.from({ length: 4 }, () => source.ensureFolder(rootId, 'A/B')),
            { concurrency: 'unbounded' },
          )
          yield* check(
            new Set(ids).size === 1,
            `four concurrent ensureFolder(A/B) calls gave ${show(ids)}`,
          )
          const a = yield* onlyNamed(source, rootId, 'A', 'folder')
          const b = yield* onlyNamed(source, a.id, 'B', 'folder')
          yield* check(
            ids.every((id) => id === b.id),
            `the calls gave ${show(ids)}, but A/B is ${b.id}`,
          )
        }),
      ),
    },
    {
      name: 'putFile of identical bytes under an existing name is a second revision of that file, not a second file',
      run: fresh((source) =>
        Effect.gen(function* () {
          const folderId = yield* scratch(source, 'Puts')
          const name = 'Term sheet.pdf'
          const content = '%PDF-1.7 Acme term sheet'
          const first = yield* source.putFile(
            folderId,
            name,
            yield* uploadOf(content),
          )
          const upload = yield* uploadOf(content)
          const second = yield* source.putFile(folderId, name, upload)
          yield* check(
            first.name === name && second.name === name,
            `putFile(${name}) twice landed as ${show([first.name, second.name])}`,
          )
          yield* check(
            second.fileId === first.fileId,
            `the same bytes under ${name} made a second file, ${second.fileId} beside ${first.fileId}`,
          )
          yield* check(
            second.revisionId !== first.revisionId,
            `the second putFile(${name}) reported the first's revision ${first.revisionId}`,
          )
          const files = yield* listed(source, folderId)
          yield* check(
            files.length === 1,
            `the folder holds ${show(files.map((e) => e.name))}, expected ${name} alone`,
          )
          const back = yield* readBack(source, first.fileId)
          yield* check(
            back.sha256 === upload.sha256,
            `${name} reads back as ${back.sha256}, not the ${upload.sha256} put`,
          )
        }),
      ),
    },
    {
      name: "putFile of different bytes under an existing name lands as 'name (2).ext' and reports the name it used",
      run: fresh((source) =>
        Effect.gen(function* () {
          const folderId = yield* scratch(source, 'Puts')
          const name = 'Term sheet.pdf'
          const suffixed = 'Term sheet (2).pdf'
          const draft2 = '%PDF-1.7 term sheet, draft 2'
          const v1 = yield* uploadOf('%PDF-1.7 term sheet, draft 1')
          const v2 = yield* uploadOf(draft2)
          const first = yield* source.putFile(folderId, name, v1)
          const second = yield* source.putFile(folderId, name, v2)
          yield* check(
            second.name === suffixed,
            `different bytes under ${name} landed as ${show(second.name)}, expected ${show(suffixed)}`,
          )
          yield* check(
            second.fileId !== first.fileId,
            `different bytes under ${name} were written over ${first.fileId}`,
          )
          const original = yield* onlyNamed(source, folderId, name, 'file')
          const copy = yield* onlyNamed(source, folderId, suffixed, 'file')
          yield* check(
            original.id === first.fileId && copy.id === second.fileId,
            `the folder lists ${show([original.id, copy.id])}, putFile reported ${show([first.fileId, second.fileId])}`,
          )
          const one = yield* readBack(source, first.fileId)
          const two = yield* readBack(source, second.fileId)
          yield* check(
            one.sha256 === v1.sha256 && two.sha256 === v2.sha256,
            `${name} and ${suffixed} read back with the wrong bytes`,
          )
          // The same rule at (2): its bytes again are its revision, not a (3).
          const again = yield* source.putFile(
            folderId,
            name,
            yield* uploadOf(draft2),
          )
          yield* check(
            again.name === suffixed && again.fileId === second.fileId,
            `${suffixed}'s bytes put again landed as ${show(again.name)} (${again.fileId}), expected a revision of ${second.fileId}`,
          )
          const third = yield* source.putFile(
            folderId,
            name,
            yield* uploadOf('%PDF-1.7 term sheet, draft 3'),
          )
          yield* check(
            third.name === 'Term sheet (3).pdf',
            `a third set of bytes landed as ${show(third.name)}, expected "Term sheet (3).pdf"`,
          )
        }),
      ),
    },
    {
      name: 'putFile never converts an uploaded docx into a native document',
      run: fresh((source) =>
        Effect.gen(function* () {
          const folderId = yield* scratch(source, 'Puts')
          const bytes = Uint8Array.from([
            ...ZIP_MAGIC,
            ...textEncoder.encode('word/document.xml Acme memo'),
          ])
          const upload = yield* uploadOf(bytes, DOCX)
          const put = yield* source.putFile(folderId, 'Memo.docx', upload)
          const entry = yield* entryIn(source, folderId, put.fileId)
          yield* check(
            entry.mime === DOCX,
            `Memo.docx lists as ${entry.mime} — converted; expected ${DOCX}`,
          )
          const back = yield* readBack(source, put.fileId)
          yield* check(
            back.mime === DOCX && back.sha256 === upload.sha256,
            `Memo.docx reads back as ${back.mime} with ${back.sha256 === upload.sha256 ? 'the same' : 'different'} bytes, expected the docx put`,
          )
        }),
      ),
    },
    {
      name: 'move is idempotent: replaying it is a no-op, not an error',
      run: fresh((source) =>
        Effect.gen(function* () {
          yield* absent(source, 'Moves')
          const from = yield* source.ensureFolder(rootId, 'Moves/From')
          const to = yield* source.ensureFolder(rootId, 'Moves/To')
          const put = yield* source.putFile(
            from,
            'Deck.pdf',
            yield* uploadOf('%PDF-1.7 deck'),
          )
          yield* source.move(put.fileId, to)
          const moved = yield* entryIn(source, to, put.fileId)
          const start = yield* source.changes(null)
          yield* source.move(put.fileId, to)
          const replayed = yield* entryIn(source, to, put.fileId)
          yield* check(
            replayed.changeToken === moved.changeToken,
            `move replayed changed Deck.pdf's changeToken ${moved.changeToken} → ${replayed.changeToken}`,
          )
          yield* quietSince(source, start.next, put.fileId, 'move')
          const left = (yield* listed(source, from)).filter(
            (e) => e.id === put.fileId,
          )
          yield* check(
            left.length === 0,
            'Deck.pdf is still listed in the folder it moved from',
          )
        }),
      ),
    },
    {
      name: 'rename is idempotent: replaying it is a no-op, not an error',
      run: fresh((source) =>
        Effect.gen(function* () {
          const folderId = yield* scratch(source, 'Renames')
          const put = yield* source.putFile(
            folderId,
            'Deck.pdf',
            yield* uploadOf('%PDF-1.7 deck'),
          )
          yield* source.rename(put.fileId, 'Deck v2.pdf')
          const renamed = yield* entryIn(source, folderId, put.fileId)
          yield* check(
            renamed.name === 'Deck v2.pdf',
            `rename gave ${show(renamed.name)}, expected "Deck v2.pdf"`,
          )
          const start = yield* source.changes(null)
          yield* source.rename(put.fileId, 'Deck v2.pdf')
          const replayed = yield* entryIn(source, folderId, put.fileId)
          yield* check(
            replayed.changeToken === renamed.changeToken &&
              replayed.name === 'Deck v2.pdf',
            `rename replayed changed the file: changeToken ${renamed.changeToken} → ${replayed.changeToken}, name ${show(replayed.name)}`,
          )
          yield* quietSince(source, start.next, put.fileId, 'rename')
        }),
      ),
    },
    {
      name: 'a write naming a missing id is NotFound, typed — not a throw',
      run: fresh((source) =>
        Effect.gen(function* () {
          const outcome = (
            attempt: Effect.Effect<unknown, StorageSourceError>,
          ) =>
            Effect.map(outcomeOf(attempt), (o) =>
              o._tag === 'failed' && o.error._tag === 'NotFound'
                ? o.error.id === missingId
                  ? 'NotFound'
                  : `failed NotFound(${o.error.id})`
                : told(o),
            )
          const upload = yield* uploadOf('%PDF-1.7 orphan')
          const attempts: ReadonlyArray<
            readonly [string, Effect.Effect<string>]
          > = [
            ['ensureFolder', outcome(source.ensureFolder(missingId, 'A'))],
            ['putFile', outcome(source.putFile(missingId, 'x.pdf', upload))],
            ['move', outcome(source.move(missingId, rootId))],
            ['rename', outcome(source.rename(missingId, 'x.pdf'))],
          ]
          for (const [method, attempt] of attempts) {
            const result = yield* attempt
            yield* check(
              result === 'NotFound',
              `${method}(${missingId}) ${result}, expected NotFound naming it`,
            )
          }
        }),
      ),
    },
  ]
}
