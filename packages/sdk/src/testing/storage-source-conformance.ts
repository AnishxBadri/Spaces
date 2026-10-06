import { Effect, Schema } from 'effect'
import type {
  StorageEntry,
  StorageSource,
  StorageSourceError,
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
