import { Effect, Layer } from 'effect'
import { JobRateLimited, JobRetryable } from '../contract.ts'
import type { JobError, JsonObject, JsonValue } from '../contract.ts'
import { Http } from '../ports.ts'
import type { HttpRequest, HttpResponse, HttpStreamResponse } from '../ports.ts'
import { NotFound } from '../storage-source.ts'
import type {
  StorageEntry,
  StorageFolder,
  StorageSourceError,
} from '../storage-source.ts'
import {
  DOCX_MIME,
  FAKE_DRIVE_CREDENTIALS,
  FAKE_DRIVE_SEED,
  GOOGLE_DOC_MIME,
  makeFakeDrive,
} from './fake-drive.ts'
import type {
  FakeDrive,
  FakeDriveCredentials,
  FakeDriveLargeFile,
  FakeDriveSeedItem,
} from './fake-drive.ts'
import type { RecordedCall, TestPort } from './index.ts'

/**
 * Google Drive's v3 REST API, in process: a `fetch`-shaped function that
 * answers the endpoints a storage-source plugin calls, backed by a
 * `FakeDrive`. A plugin's real HTTP code runs against it — URLs, query
 * parameters, `fields`, paging, export — while the fake's mutators and
 * toggles (`rateLimit`, `evictCursors`, `vanishAfterList`, `revoke`) decide
 * the answers.
 *
 * - Every request is recorded with its query, so a test asserts what was sent.
 * - A request without `Authorization: Bearer <accessToken>` is a 401.
 * - `fields` is honoured, and its absence gives Drive's default fields, so a
 *   plugin that forgets to ask for a field does not get it.
 * - A native Doc exports to docx with a fresh stamp each time: like Drive's,
 *   the export is not byte-stable.
 * - Mutate through `drive` (not a second handle on the same `FakeDrive`):
 *   the API keeps its own index of where each item lives.
 * - Writes are Drive's raw ones: a folder create never looks for one of the
 *   same name, so racing creates fork the tree as Drive's do. Uploads are
 *   resumable sessions held to Drive's 256 KiB chunk rule, and convert only
 *   when the metadata asks for a native mime.
 */

export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Every chunk of a resumable upload but the last is a multiple of this. */
export const RESUMABLE_CHUNK_MULTIPLE = 256 * 1024

/** What `fetch` is handed — `globalThis.fetch`'s shape, as the live Http port calls it. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string
    readonly headers: Record<string, string>
    readonly body?: string | Uint8Array<ArrayBuffer>
  },
) => Promise<Response>

/** One request the fake API received. `path` is relative to `DRIVE_API`, or to `DRIVE_UPLOAD_API` for an upload. */
export type DriveApiRequest = {
  readonly method: string
  readonly url: string
  readonly upload: boolean
  readonly path: string
  /** A parameter the request did not send reads as undefined. */
  readonly query: { readonly [name: string]: string | undefined }
}

export type FakeDriveApi = {
  readonly fetch: FetchLike
  /** The Drive behind the API: its mutators and toggles drive the answers. */
  readonly drive: FakeDrive
  readonly requests: ReadonlyArray<DriveApiRequest>
  /** The bearer token the API accepts. */
  readonly accessToken: string
  /** How many exports it has served. */
  readonly exports: () => number
}

export type FakeDriveApiOptions = {
  readonly seed?: ReadonlyArray<FakeDriveSeedItem>
  /** Generated on read and streamed through, never held (`FAKE_DRIVE_SCAN`). */
  readonly largeFiles?: ReadonlyArray<FakeDriveLargeFile>
  readonly credentials?: FakeDriveCredentials
  /** The root that is My Drive; every other root is a shared drive. */
  readonly myDriveId?: string
}

const encoder = new TextEncoder()

const json = (
  status: number,
  body: JsonValue,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/** Drive's error envelope. */
const driveError = (
  status: number,
  reason: string,
  message: string,
  headers: Record<string, string> = {},
): Response =>
  json(
    status,
    { error: { code: status, message, errors: [{ reason, message }] } },
    headers,
  )

// ---------------------------------------------------------------------------
// `fields`
// ---------------------------------------------------------------------------

type Selection = ReadonlyMap<string, Selection | null>

/** `nextPageToken,files(id,name)` → a tree of the keys asked for. */
const parseFields = (text: string): Selection | '*' => {
  if (text.trim() === '*') return '*'
  const out = new Map<string, Selection | null>()
  let depth = 0
  let start = 0
  const take = (part: string) => {
    const trimmed = part.trim()
    if (trimmed === '') return
    const open = trimmed.indexOf('(')
    if (open < 0) out.set(trimmed, null)
    else {
      const inner = parseFields(trimmed.slice(open + 1, -1))
      out.set(trimmed.slice(0, open).trim(), inner === '*' ? null : inner)
    }
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      take(text.slice(start, i))
      start = i + 1
    }
  }
  take(text.slice(start))
  return out
}

const isJsonArray = (value: JsonValue): value is ReadonlyArray<JsonValue> =>
  Array.isArray(value)

const select = (value: JsonValue, selection: Selection | null): JsonValue => {
  if (selection === null || value === null || typeof value !== 'object')
    return value
  if (isJsonArray(value)) return value.map((item) => select(item, selection))
  const out: { [key: string]: JsonValue } = {}
  for (const [key, sub] of selection)
    if (Object.hasOwn(value, key)) out[key] = select(value[key], sub)
  return out
}

const withFields = (
  body: JsonObject,
  fields: string | undefined,
  defaults: string,
): JsonValue => {
  const parsed = parseFields(fields ?? defaults)
  return parsed === '*' ? body : select(body, parsed)
}

const FILE_DEFAULT_FIELDS = 'kind,id,name,mimeType'
const LIST_DEFAULT_FIELDS =
  'kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)'

/** A JSON object without its undefined members. */
const compact = (value: {
  readonly [key: string]: JsonValue | undefined
}): JsonObject => {
  const out: { [key: string]: JsonValue } = {}
  for (const [key, v] of Object.entries(value))
    if (v !== undefined) out[key] = v
  return out
}

/** A `files.list` query: one parent, and optionally a name and a mime test. */
type FileQuery = {
  readonly parentId: string
  readonly name?: string
  readonly mime?: { readonly equal: boolean; readonly value: string }
}

const QUOTED = String.raw`'((?:[^'\\]|\\.)*)'`

/** One clause of the `q` grammar the fake reads; anything else is Drive's 400. */
const CLAUSE = new RegExp(
  String.raw`\s*(?:${QUOTED}\s+in\s+parents|trashed\s*=\s*false|name\s*=\s*${QUOTED}|mimeType\s*(!=|=)\s*${QUOTED})\s*`,
  'y',
)
const AND = /and(?=\s)/y

const unquote = (text: string) => text.replace(/\\(.)/g, '$1')

/** `'<id>' in parents and name = 'A' and mimeType = '…' and trashed = false`, clauses in any order. */
const parseQuery = (q: string): FileQuery | null => {
  let parentId: string | undefined
  let name: string | undefined
  let mime: FileQuery['mime']
  for (let at = 0; ;) {
    CLAUSE.lastIndex = at
    const clause = CLAUSE.exec(q)
    if (clause === null) return null
    const [parent, named, op, mimeValue] = [1, 2, 3, 4].map((i) => clause.at(i))
    if (parent !== undefined) parentId = unquote(parent)
    if (named !== undefined) name = unquote(named)
    if (op !== undefined && mimeValue !== undefined)
      mime = { equal: op === '=', value: unquote(mimeValue) }
    at = CLAUSE.lastIndex
    if (at === q.length) break
    AND.lastIndex = at
    if (AND.exec(q) === null) return null
    at = AND.lastIndex
  }
  if (parentId === undefined) return null
  return {
    parentId,
    ...(name === undefined ? {} : { name }),
    ...(mime === undefined ? {} : { mime }),
  }
}

const isRecord = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A JSON request body as an object; null when there is none or it is not one. */
const jsonBody = (
  body: string | Uint8Array | undefined,
): { [key: string]: unknown } | null => {
  if (body === undefined) return {}
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body)
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** `bytes 0-262143/*`, `bytes 262144-300000/300001` or `bytes *\/300001`. */
const parseContentRange = (
  header: string | undefined,
): {
  readonly start: number | null
  readonly end: number | null
  readonly total: number | null
} | null => {
  const match = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(header ?? '')
  if (match === null) return null
  const [start, end, total] = [1, 2, 3].map((i) => match.at(i))
  return {
    start: start === undefined ? null : Number(start),
    end: end === undefined ? null : Number(end),
    total: total === undefined || total === '*' ? null : Number(total),
  }
}

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** One resumable upload, from its first request to its last chunk. */
type UploadSession = {
  readonly target:
    | {
        readonly kind: 'create'
        readonly name: string
        readonly parentId: string
        readonly mime: string
      }
    | { readonly kind: 'update'; readonly fileId: string }
  readonly fields: string | undefined
  readonly chunks: Array<Uint8Array>
  received: number
}

const LIST_PAGE_MAX = 1000

export const makeFakeDriveApi = (
  options: FakeDriveApiOptions = {},
): FakeDriveApi => {
  const seed = options.seed ?? FAKE_DRIVE_SEED
  const credentials = options.credentials ?? FAKE_DRIVE_CREDENTIALS
  const myDriveId = options.myDriveId ?? 'root'
  const largeFiles = options.largeFiles ?? []
  const inner = makeFakeDrive({ seed, credentials, largeFiles })
  const requests: Array<DriveApiRequest> = []
  /** Where each item was last seen: its parent, null for a root. */
  const parentOf = new Map<string, string | null>()
  const roots = new Set<string>()
  let exported = 0

  const place = (id: string, parentId: string | null) => {
    parentOf.set(id, parentId)
    if (parentId === null) roots.add(id)
  }
  for (const item of [...seed, ...largeFiles]) place(item.id, item.parentId)

  const drive: FakeDrive = {
    ...inner,
    add: (item) => {
      inner.add(item)
      place(item.id, item.parentId)
    },
    move: (id, parentId) => {
      inner.move(id, parentId)
      place(id, parentId)
    },
    create: (spec) => {
      const entry = inner.create(spec)
      place(entry.id, entry.parentId)
      return entry
    },
    // The removed id keeps its last parent, so its removal is filed under its drive.
    remove: (id) => {
      inner.remove(id)
      roots.delete(id)
    },
  }
  const { source } = inner

  /** The root an item sits under, as far as the index knows. */
  const rootOf = (id: string): string | undefined => {
    let at: string | undefined = id
    for (let hops = 0; at !== undefined && hops < 1000; hops++) {
      const up = parentOf.get(at)
      if (up === null) return at
      at = up
    }
    return undefined
  }

  /** A shared drive's id for an item in one; undefined in My Drive. */
  const sharedDriveOf = (id: string): string | undefined => {
    const root = rootOf(id)
    return root === undefined || root === myDriveId ? undefined : root
  }

  const fileJson = (entry: StorageEntry): JsonObject => {
    place(entry.id, entry.parentId)
    const fields = inner.driveFields(entry.id)
    return compact({
      createdTime: fields?.createdTime,
      headRevisionId: fields?.headRevisionId,
      sha256Checksum: fields?.sha256Checksum,
      kind: 'drive#file',
      id: entry.id,
      name: entry.name,
      mimeType: entry.mime,
      parents: entry.parentId === null ? undefined : [entry.parentId],
      size: entry.size === null ? undefined : String(entry.size),
      modifiedTime: entry.modifiedAt,
      version: entry.changeToken,
      driveId: sharedDriveOf(entry.id),
    })
  }

  const folderJson = (folder: StorageFolder): JsonObject => {
    const chain = [...folder.parents.map((p) => p.id), folder.id]
    chain.forEach((id, i) => place(id, i === 0 ? null : (chain[i - 1] ?? null)))
    const parent = folder.parents.at(-1)
    return compact({
      createdTime: inner.driveFields(folder.id)?.createdTime,
      kind: 'drive#file',
      id: folder.id,
      name: folder.name,
      mimeType: DRIVE_FOLDER_MIME,
      parents: parent === undefined ? undefined : [parent.id],
      driveId: sharedDriveOf(folder.id),
    })
  }

  /** Every child of a folder, paged through. */
  const listAll = (folderId: string) =>
    Effect.gen(function* () {
      const entries: Array<StorageEntry> = []
      let cursor: string | undefined
      do {
        const page = yield* source.listFolder(
          folderId,
          cursor === undefined
            ? { pageSize: LIST_PAGE_MAX }
            : { pageSize: LIST_PAGE_MAX, cursor },
        )
        entries.push(...page.entries)
        cursor = page.next
      } while (cursor !== undefined)
      for (const entry of entries) place(entry.id, entry.parentId)
      return entries
    })

  /** A file's listing entry: under its indexed parent, else by a walk from every root. */
  const fileEntry = (id: string) =>
    Effect.gen(function* () {
      const parent = parentOf.get(id)
      if (typeof parent === 'string') {
        const found = (yield* listAll(parent).pipe(
          Effect.catchTag('NotFound', () => Effect.succeed([])),
        )).find((e) => e.id === id)
        if (found !== undefined) return found
      }
      // Breadth first; the loop visits what it appends.
      const queue = [...roots]
      for (const folder of queue) {
        const children = yield* listAll(folder).pipe(
          Effect.catchTag('NotFound', () => Effect.succeed([])),
        )
        const found = children.find((e) => e.id === id)
        if (found !== undefined) return found
        for (const child of children)
          if (child.kind === 'folder') queue.push(child.id)
      }
      return yield* new NotFound({ id })
    })

  /** files.get's metadata. The folder probe is the gated call that runs first. */
  const metadata = (id: string) =>
    source.getFolder(id).pipe(
      Effect.map(folderJson),
      Effect.catchTag('NotFound', () =>
        inner.providerHash(id) === undefined
          ? Effect.fail(new NotFound({ id }))
          : Effect.map(fileEntry(id), fileJson),
      ),
    )

  /** A port failure as Drive answers it. */
  const failed = (error: StorageSourceError, expiredStatus: number) => {
    switch (error._tag) {
      case 'NotFound':
        return driveError(404, 'notFound', `File not found: ${error.id}.`)
      case 'RateLimited':
        return driveError(429, 'rateLimitExceeded', 'Rate limit exceeded.', {
          'retry-after': String(Math.ceil(error.retryAfterMs / 1000)),
        })
      case 'AuthExpired':
        return driveError(401, 'authError', 'Invalid Credentials')
      case 'CursorExpired':
        return expiredStatus === 410
          ? driveError(410, 'deleted', 'The page token has expired.')
          : driveError(400, 'invalid', 'Invalid Value')
    }
  }

  const answer = <TValue>(
    effect: Effect.Effect<TValue, StorageSourceError>,
    ok: (value: TValue) => Response,
    expiredStatus = 400,
  ): Promise<Response> =>
    Effect.runPromise(
      Effect.match(effect, {
        onFailure: (error) => failed(error, expiredStatus),
        onSuccess: ok,
      }),
    )

  const isSharedDrive = (id: string) => id !== myDriveId && roots.has(id)

  const filesGet = (id: string, query: Query) => {
    if (query.alt === 'media')
      return answer(
        Effect.gen(function* () {
          const meta = yield* metadata(id)
          if (
            typeof meta.mimeType === 'string' &&
            meta.mimeType.startsWith('application/vnd.google-apps.')
          )
            return null
          return yield* source.getFile(id)
        }),
        (file) =>
          file === null
            ? driveError(
                403,
                'fileNotDownloadable',
                'Only files with binary content can be downloaded. Use Export with Docs Editors files.',
              )
            : new Response(file.stream, {
                status: 200,
                headers: { 'content-type': file.mime },
              }),
      )
    return answer(metadata(id), (meta) =>
      json(200, withFields(meta, query.fields, FILE_DEFAULT_FIELDS)),
    )
  }

  const filesExport = (id: string, query: Query) =>
    answer(
      Effect.gen(function* () {
        const meta = yield* metadata(id)
        if (meta.mimeType !== GOOGLE_DOC_MIME) return null
        return yield* source.getFile(id)
      }),
      (file) => {
        if (file === null)
          return driveError(
            403,
            'fileNotExportable',
            'Export only supports Docs Editors files.',
          )
        if (query.mimeType !== DOCX_MIME)
          return driveError(
            400,
            'badRequest',
            `The requested conversion is not supported: ${query.mimeType ?? '(none)'}.`,
          )
        // Like Drive's: the zip carries a fresh timestamp on every export.
        const stamp = encoder.encode(`\ndocProps/core.xml export=${++exported}`)
        const stamped = file.stream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            flush: (controller) => controller.enqueue(stamp),
          }),
        )
        return new Response(stamped, {
          status: 200,
          headers: { 'content-type': DOCX_MIME },
        })
      },
    )

  const filesList = (query: Query) => {
    const parsed = parseQuery(query.q ?? '')
    if (parsed === null)
      return Promise.resolve(
        driveError(400, 'invalid', `Invalid Value: q=${query.q ?? '(none)'}`),
      )
    const folderId = parsed.parentId
    const pageSize = Math.min(
      LIST_PAGE_MAX,
      Math.max(1, Number(query.pageSize ?? '100') || 100),
    )
    // Shared-drive items are left out unless the caller asks for all drives.
    const hidden =
      sharedDriveOf(folderId) !== undefined &&
      query.includeItemsFromAllDrives !== 'true'
    const page = (files: ReadonlyArray<StorageEntry>, next?: string) =>
      json(
        200,
        withFields(
          compact({
            kind: 'drive#fileList',
            incompleteSearch: false,
            nextPageToken: hidden ? undefined : next,
            files: hidden ? [] : files.map(fileJson),
          }),
          query.fields,
          LIST_DEFAULT_FIELDS,
        ),
      )
    // A name or mime test: the whole folder filtered, paged by offset.
    if (parsed.name !== undefined || parsed.mime !== undefined) {
      const offset =
        query.pageToken === undefined
          ? 0
          : Number(/^filtered:(\d+)$/.exec(query.pageToken)?.[1] ?? NaN)
      if (Number.isNaN(offset))
        return Promise.resolve(driveError(400, 'invalid', 'Invalid Value'))
      const { name, mime } = parsed
      return answer(listAll(folderId), (entries) => {
        const matching = entries.filter(
          (e) =>
            (name === undefined || e.name === name) &&
            (mime === undefined || (e.mime === mime.value) === mime.equal),
        )
        const end = offset + pageSize
        return page(
          matching.slice(offset, end),
          end < matching.length ? `filtered:${end}` : undefined,
        )
      })
    }
    return answer(
      source.listFolder(
        folderId,
        query.pageToken === undefined
          ? { pageSize }
          : { pageSize, cursor: query.pageToken },
      ),
      (listing) => page(listing.entries, listing.next),
    )
  }

  // -------------------------------------------------------------------------
  // Writes. Each first reads through a gated port call, so a revoked token
  // or a rate limit answers a write as it answers a read.
  // -------------------------------------------------------------------------

  /** A write into a shared drive must say `supportsAllDrives`, or Drive cannot find the parent. */
  const reachable = (id: string, query: Query) =>
    sharedDriveOf(id) === undefined || query.supportsAllDrives === 'true'

  const notFound = (id: string) =>
    driveError(404, 'notFound', `File not found: ${id}.`)

  const entryJson = (id: string, query: Query, fields = query.fields) => {
    const entry = drive.entry(id)
    return entry === undefined
      ? notFound(id)
      : json(200, withFields(fileJson(entry), fields, FILE_DEFAULT_FIELDS))
  }

  /** files.create, metadata only: a folder. Never looks for one of the same name. */
  const filesCreate = (query: Query, body: RequestBody) => {
    const meta = jsonBody(body)
    const parents = meta?.parents
    const parentId = Array.isArray(parents) ? parents.at(0) : undefined
    const name = meta?.name
    if (
      typeof name !== 'string' ||
      typeof parentId !== 'string' ||
      !Array.isArray(parents) ||
      parents.length !== 1 ||
      meta?.mimeType !== DRIVE_FOLDER_MIME
    )
      return Promise.resolve(
        driveError(
          400,
          'badRequest',
          'The fake creates folders only: name, one parent, the folder mime.',
        ),
      )
    if (!reachable(parentId, query)) return Promise.resolve(notFound(parentId))
    return answer(source.getFolder(parentId), () => {
      const entry = drive.create({ kind: 'folder', name, parentId })
      return entryJson(entry.id, query)
    })
  }

  /** files.update, metadata only: `name`, and a move by `addParents`/`removeParents`. */
  const filesUpdate = (id: string, query: Query, body: RequestBody) => {
    const meta = jsonBody(body)
    const name = meta?.name
    if (meta === null || (name !== undefined && typeof name !== 'string'))
      return Promise.resolve(driveError(400, 'badRequest', 'Invalid body'))
    const { addParents, removeParents } = query
    if (!reachable(id, query)) return Promise.resolve(notFound(id))
    return answer(
      Effect.gen(function* () {
        yield* metadata(id)
        if (addParents !== undefined) yield* source.getFolder(addParents)
        const current = drive.entry(id)?.parentId ?? null
        const removing = (removeParents ?? '').split(',')
        // Drive keeps one parent: a second is refused, not added.
        if (
          addParents !== undefined &&
          current !== null &&
          current !== addParents &&
          !removing.includes(current)
        )
          return driveError(
            403,
            'cannotAddParent',
            'Increasing the number of parents is not allowed.',
          )
        if (typeof name === 'string') drive.rename(id, name)
        if (addParents !== undefined && current !== addParents)
          drive.move(id, addParents)
        return entryJson(id, query)
      }),
      (response) => response,
    )
  }

  /** files.delete: gone for good, with everything under it. */
  const filesDelete = (id: string, query: Query) => {
    if (!reachable(id, query)) return Promise.resolve(notFound(id))
    return answer(metadata(id), () => {
      drive.remove(id)
      return new Response(null, { status: 204 })
    })
  }

  const sessions = new Map<string, UploadSession>()
  let sessionCount = 0

  /** The first request of a resumable upload: a new file, or new content for one. */
  const uploadStart = (
    method: string,
    fileId: string | undefined,
    query: Query,
    headers: Record<string, string>,
    body: RequestBody,
  ) => {
    if (query.uploadType !== 'resumable')
      return Promise.resolve(
        driveError(400, 'badRequest', 'The fake takes resumable uploads only'),
      )
    const meta = jsonBody(body)
    if (meta === null)
      return Promise.resolve(driveError(400, 'badRequest', 'Invalid body'))
    const open = (target: UploadSession['target']) => {
      const id = `upload-${++sessionCount}`
      sessions.set(id, {
        target,
        fields: query.fields,
        chunks: [],
        received: 0,
      })
      const at =
        target.kind === 'update'
          ? `/files/${encodeURIComponent(target.fileId)}`
          : '/files'
      return new Response(null, {
        status: 200,
        headers: {
          location: `${DRIVE_UPLOAD_API}${at}?uploadType=resumable&upload_id=${id}`,
        },
      })
    }
    if (method === 'PATCH' && fileId !== undefined) {
      if (!reachable(fileId, query)) return Promise.resolve(notFound(fileId))
      return answer(metadata(fileId), (file) =>
        file.mimeType === DRIVE_FOLDER_MIME
          ? driveError(400, 'badRequest', 'A folder has no content')
          : open({ kind: 'update', fileId }),
      )
    }
    const parents = meta.parents
    const parentId = Array.isArray(parents) ? parents.at(0) : undefined
    const { name, mimeType } = meta
    if (
      method !== 'POST' ||
      fileId !== undefined ||
      typeof name !== 'string' ||
      typeof parentId !== 'string' ||
      (mimeType !== undefined && typeof mimeType !== 'string')
    )
      return Promise.resolve(
        driveError(400, 'badRequest', 'Invalid upload metadata'),
      )
    if (!reachable(parentId, query)) return Promise.resolve(notFound(parentId))
    const mime =
      mimeType ??
      (Object.hasOwn(headers, 'x-upload-content-type')
        ? headers['x-upload-content-type']
        : 'application/octet-stream')
    return answer(source.getFolder(parentId), () =>
      open({ kind: 'create', name, parentId, mime }),
    )
  }

  /** One chunk of a session; the last one lands the file. */
  const uploadChunk = (
    sessionId: string,
    headers: Record<string, string>,
    body: RequestBody,
  ) => {
    const session = sessions.get(sessionId)
    if (session === undefined)
      return Promise.resolve(
        driveError(404, 'notFound', 'No such upload session'),
      )
    const range = parseContentRange(headers['content-range'])
    const bytes =
      body === undefined
        ? new Uint8Array()
        : typeof body === 'string'
          ? encoder.encode(body)
          : body
    const sent = range?.start === null ? 0 : bytes.byteLength
    const final = range?.total ?? null
    if (
      range === null ||
      (range.start !== null &&
        (range.start !== session.received ||
          range.end !== range.start + bytes.byteLength - 1)) ||
      (range.start === null && bytes.byteLength > 0) ||
      (final !== null && session.received + sent !== final) ||
      (final === null && sent % RESUMABLE_CHUNK_MULTIPLE !== 0)
    )
      return Promise.resolve(
        driveError(
          400,
          'badContentRange',
          `Content-Range ${headers['content-range'] ?? '(none)'} does not follow ${session.received} bytes received, or a non-final chunk is not a multiple of 256 KiB`,
        ),
      )
    const { target } = session
    const parentId =
      target.kind === 'create'
        ? target.parentId
        : (drive.entry(target.fileId)?.parentId ?? target.fileId)
    return answer(source.getFolder(parentId), () => {
      session.chunks.push(bytes.slice())
      session.received += sent
      if (final === null)
        return new Response(null, {
          status: 308,
          headers:
            session.received === 0
              ? {}
              : { range: `bytes=0-${session.received - 1}` },
        })
      sessions.delete(sessionId)
      const content = concat(session.chunks)
      if (target.kind === 'update') {
        drive.upload(target.fileId, content)
        return entryJson(target.fileId, {}, session.fields)
      }
      // Drive converts only when the metadata names a native mime.
      const native = target.mime.startsWith('application/vnd.google-apps.')
      if (target.mime === DRIVE_FOLDER_MIME)
        return driveError(400, 'badRequest', 'A folder has no content')
      const entry = drive.create({
        kind: native ? 'native' : 'file',
        name: target.name,
        parentId: target.parentId,
        mime: target.mime,
        bytes: content,
      })
      return entryJson(entry.id, {}, session.fields)
    })
  }

  const startPageToken = (query: Query) => {
    if (query.driveId !== undefined && !isSharedDrive(query.driveId))
      return Promise.resolve(
        driveError(404, 'notFound', `Shared drive not found: ${query.driveId}`),
      )
    return answer(source.changes(null), (page) =>
      json(200, { kind: 'drive#startPageToken', startPageToken: page.next }),
    )
  }

  const changesList = (query: Query) => {
    const { pageToken, driveId } = query
    if (pageToken === undefined)
      return Promise.resolve(
        driveError(400, 'required', 'Required parameter: pageToken'),
      )
    if (driveId !== undefined) {
      if (!isSharedDrive(driveId))
        return Promise.resolve(
          driveError(404, 'notFound', `Shared drive not found: ${driveId}`),
        )
      if (query.supportsAllDrives !== 'true')
        return Promise.resolve(
          driveError(
            403,
            'teamDrivesSupportRequired',
            'The driveId parameter requires supportsAllDrives=true.',
          ),
        )
    }
    return answer(
      source.changes(pageToken),
      (page) => {
        const changes: Array<JsonObject> = []
        for (const change of page.changes) {
          const id = change._tag === 'changed' ? change.entry.id : change.id
          const file = change._tag === 'changed' ? fileJson(change.entry) : null
          const shared = sharedDriveOf(id)
          // Each drive has its own feed: My Drive's holds no shared-drive item.
          if (driveId !== shared) continue
          changes.push(
            compact({
              kind: 'drive#change',
              changeType: 'file',
              fileId: id,
              removed: change._tag === 'removed',
              file: file ?? undefined,
              driveId: shared,
            }),
          )
        }
        return json(
          200,
          withFields(
            {
              kind: 'drive#changeList',
              newStartPageToken: page.next,
              changes,
            },
            query.fields,
            '*',
          ),
        )
      },
      410,
    )
  }

  const drivesList = () =>
    answer(
      Effect.forEach(
        [...roots].filter((id) => id !== myDriveId),
        (id) => source.getFolder(id),
      ),
      (folders) =>
        json(200, {
          kind: 'drive#driveList',
          drives: folders.map((f) => ({
            kind: 'drive#drive',
            id: f.id,
            name: f.name,
          })),
        }),
    )

  type Query = { readonly [name: string]: string | undefined }
  type RequestBody = string | Uint8Array<ArrayBuffer> | undefined

  const route = (
    method: string,
    path: string,
    query: Query,
    body: RequestBody,
  ): Promise<Response> => {
    const fileOf = /^\/files\/([^/]+)$/.exec(path)?.[1]
    const fileId = fileOf === undefined ? undefined : decodeURIComponent(fileOf)
    if (method === 'POST' && path === '/files') return filesCreate(query, body)
    if (method === 'PATCH' && fileId !== undefined)
      return filesUpdate(fileId, query, body)
    if (method === 'DELETE' && fileId !== undefined)
      return filesDelete(fileId, query)
    if (method !== 'GET')
      return Promise.resolve(
        driveError(405, 'methodNotAllowed', `${method} ${path} is not served`),
      )
    if (path === '/files') return filesList(query)
    if (path === '/changes/startPageToken') return startPageToken(query)
    if (path === '/changes') return changesList(query)
    if (path === '/drives') return drivesList()
    // Who the token is: refused once the connection is revoked.
    if (path === '/about')
      return answer(source.pickerConfig(), () =>
        json(
          200,
          withFields(
            {
              kind: 'drive#about',
              user: { kind: 'drive#user', displayName: 'Fake Drive user' },
            },
            query.fields,
            '*',
          ),
        ),
      )
    const exportOf = /^\/files\/([^/]+)\/export$/.exec(path)?.[1]
    if (exportOf !== undefined)
      return filesExport(decodeURIComponent(exportOf), query)
    if (fileId !== undefined) return filesGet(fileId, query)
    return Promise.resolve(
      driveError(404, 'notFound', `The fake Drive API has no ${path}`),
    )
  }

  /** The upload endpoint: a session's first request, or one of its chunks. */
  const routeUpload = (
    method: string,
    path: string,
    query: Query,
    headers: Record<string, string>,
    body: RequestBody,
  ): Promise<Response> => {
    const fileOf = /^\/files(?:\/([^/]+))?$/.exec(path)
    if (fileOf === null)
      return Promise.resolve(
        driveError(404, 'notFound', `The fake upload API has no ${path}`),
      )
    const named = fileOf.at(1)
    const fileId = named === undefined ? undefined : decodeURIComponent(named)
    if (query.upload_id !== undefined && method === 'PUT')
      return uploadChunk(query.upload_id, headers, body)
    return uploadStart(method, fileId, query, headers, body)
  }

  const fetch: FetchLike = (url, init) => {
    const parsed = new URL(url)
    const query: { [name: string]: string } = {}
    parsed.searchParams.forEach((value, name) => {
      query[name] = value
    })
    const at = `${parsed.origin}${parsed.pathname}`
    const base = [DRIVE_UPLOAD_API, DRIVE_API].find((api) => at.startsWith(api))
    const upload = base === DRIVE_UPLOAD_API
    const path = base === undefined ? parsed.pathname : at.slice(base.length)
    requests.push({ method: init.method, url, upload, path, query })
    if (base === undefined)
      return Promise.resolve(
        driveError(404, 'notFound', `${url} is not the Drive API`),
      )
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(init.headers))
      headers[name.toLowerCase()] = value
    if (headers.authorization !== `Bearer ${credentials.accessToken}`)
      return Promise.resolve(
        driveError(401, 'authError', 'Invalid Credentials'),
      )
    return upload
      ? routeUpload(init.method, path, query, headers, init.body)
      : route(init.method, path, query, init.body)
  }

  return {
    fetch,
    drive,
    requests,
    accessToken: credentials.accessToken,
    exports: () => exported,
  }
}

/**
 * An Http port over a `fetch`, for a plugin test that runs its real HTTP
 * code against a fake API. A 429 fails `JobRateLimited` with `Retry-After`
 * as the delay, as `HttpTest` and the live port's second 429 do; a fetch
 * that throws is `JobRetryable`. Bodies pass through: `stream` hands the
 * response body over unread.
 */
export const HttpFetchTest = (fetch: FetchLike): TestPort<Http> => {
  const calls: Array<RecordedCall> = []
  const send = (method: 'request' | 'stream', request: HttpRequest) =>
    Effect.gen(function* () {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(request.headers ?? {}))
        headers[k.toLowerCase()] = v
      const body =
        request.body === undefined
          ? undefined
          : typeof request.body === 'string' ||
              request.body instanceof Uint8Array
            ? request.body
            : JSON.stringify(request.body)
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(request.url, {
            method: request.method,
            headers,
            ...(body === undefined ? {} : { body }),
          }),
        catch: (error) =>
          new JobRetryable({
            reason: `${request.method} ${request.url} failed: ${String(error)}`,
          }),
      })
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value
      })
      calls.push({
        port: 'Http',
        method,
        input: { ...request, headers },
        output: { status: res.status },
      })
      if (res.status === 429) {
        yield* Effect.promise(() => res.body?.cancel() ?? Promise.resolve())
        const seconds = Number(responseHeaders['retry-after'] ?? '60')
        return yield* new JobRateLimited({
          reason: `${request.url} is rate-limited`,
          retryAfterMs: (Number.isFinite(seconds) ? seconds : 60) * 1000,
        })
      }
      return { res, headers: responseHeaders }
    })
  const request = (input: HttpRequest): Effect.Effect<HttpResponse, JobError> =>
    Effect.gen(function* () {
      const { res, headers } = yield* send('request', input)
      const body = yield* Effect.promise(() => res.text())
      return { status: res.status, headers, body }
    })
  const stream = (
    input: HttpRequest,
  ): Effect.Effect<HttpStreamResponse, JobError> =>
    Effect.map(send('stream', input), ({ res, headers }) => ({
      status: res.status,
      headers,
      body: res.body ?? new Blob([]).stream(),
    }))
  return { layer: Layer.succeed(Http, { request, stream }), calls }
}
