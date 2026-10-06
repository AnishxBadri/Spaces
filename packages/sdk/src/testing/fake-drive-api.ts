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
 */

export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

/** What `fetch` is handed — `globalThis.fetch`'s shape, as the live Http port calls it. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string
    readonly headers: Record<string, string>
    readonly body?: string
  },
) => Promise<Response>

/** One request the fake API received. `path` is relative to `DRIVE_API`. */
export type DriveApiRequest = {
  readonly method: string
  readonly url: string
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

/** `'<id>' in parents`, optionally `and trashed = false` — the one query a listing sends. */
const PARENTS_QUERY =
  /^\s*'([^'\\]+)'\s+in\s+parents(?:\s+and\s+trashed\s*=\s*false)?\s*$/

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
    return compact({
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
    const match = PARENTS_QUERY.exec(query.q ?? '')
    const folderId = match?.[1]
    if (folderId === undefined)
      return Promise.resolve(
        driveError(400, 'invalid', `Invalid Value: q=${query.q ?? '(none)'}`),
      )
    const pageSize = Math.min(
      LIST_PAGE_MAX,
      Math.max(1, Number(query.pageSize ?? '100') || 100),
    )
    // Shared-drive items are left out unless the caller asks for all drives.
    const hidden =
      sharedDriveOf(folderId) !== undefined &&
      query.includeItemsFromAllDrives !== 'true'
    return answer(
      source.listFolder(
        folderId,
        query.pageToken === undefined
          ? { pageSize }
          : { pageSize, cursor: query.pageToken },
      ),
      (page) =>
        json(
          200,
          withFields(
            compact({
              kind: 'drive#fileList',
              incompleteSearch: false,
              nextPageToken: hidden ? undefined : page.next,
              files: hidden ? [] : page.entries.map(fileJson),
            }),
            query.fields,
            LIST_DEFAULT_FIELDS,
          ),
        ),
    )
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

  const route = (path: string, query: Query): Promise<Response> => {
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
    const fileOf = /^\/files\/([^/]+)$/.exec(path)?.[1]
    if (fileOf !== undefined) return filesGet(decodeURIComponent(fileOf), query)
    return Promise.resolve(
      driveError(404, 'notFound', `The fake Drive API has no ${path}`),
    )
  }

  const fetch: FetchLike = (url, init) => {
    const parsed = new URL(url)
    const query: { [name: string]: string } = {}
    parsed.searchParams.forEach((value, name) => {
      query[name] = value
    })
    const path = `${parsed.origin}${parsed.pathname}`.startsWith(DRIVE_API)
      ? `${parsed.origin}${parsed.pathname}`.slice(DRIVE_API.length)
      : parsed.pathname
    requests.push({ method: init.method, url, path, query })
    if (!`${parsed.origin}${parsed.pathname}`.startsWith(DRIVE_API))
      return Promise.resolve(
        driveError(404, 'notFound', `${url} is not the Drive API`),
      )
    const authorization = Object.entries(init.headers).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1]
    if (authorization !== `Bearer ${credentials.accessToken}`)
      return Promise.resolve(
        driveError(401, 'authError', 'Invalid Credentials'),
      )
    if (init.method !== 'GET')
      return Promise.resolve(
        driveError(405, 'methodNotAllowed', `${init.method} is not served`),
      )
    return route(path, query)
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
          : typeof request.body === 'string'
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
