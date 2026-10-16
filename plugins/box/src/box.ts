import { Effect, Redacted } from 'effect'
import { z } from 'zod'
import {
  AuthExpired,
  CursorExpired,
  Http,
  NotFound,
  RateLimited,
  Secrets,
  collisionName,
  pathSegments,
} from '@spaces/sdk'
import type {
  ChangePage,
  FolderPage,
  HttpMethod,
  HttpResponse,
  HttpStreamResponse,
  JobError,
  JsonObject,
  LinkTarget,
  ListFolderOptions,
  PickerConfig,
  PutFileResult,
  StorageChange,
  StorageEntry,
  StorageFile,
  StorageFolder,
  StorageUpload,
  WritableStorageSource,
} from '@spaces/sdk'
import { parseBoxLink } from './links.ts'

/**
 * The storage-source port over Box's content API: every
 * request through the Http port, with a bearer token from
 * `Secrets.accessToken()` fetched per call so a refreshed token is the one
 * sent. Box's refresh token is single-use; the host's row lock is what
 * keeps two refreshes from spending it twice.
 *
 * - Box sends no mime type: a file's is read from its extension.
 * - A Box Note's bytes are its `extracted_text` representation, plain text,
 *   so it hashes the same each time it is read. Every other file streams
 *   through Box's download redirect.
 * - `changeToken` is Box's `etag`, which moves on any change — never `sha1`.
 * - `changes` reads the events stream (Box has no per-folder delta); a
 *   stream position Box no longer holds is `CursorExpired`.
 * - A failure the port's types cannot name — Box answering a request this
 *   code built wrong, or JSON that is not Box's — is a defect, not a guess.
 * - Writes lean on Box's unique names: a create that loses a race is a 409
 *   naming the winner, so nothing is looked up first and nothing forks.
 *   The collision check compares Box's `sha1` with our SHA-1 of the bytes.
 * - An upload is one multipart request, so a `putFile` holds the whole file,
 *   up to `UPLOAD_MAX_BYTES` — Box's chunked sessions need the size first,
 *   and a stream does not say it.
 */

export const BOX_API = 'https://api.box.com/2.0'
export const BOX_UPLOAD = 'https://upload.box.com/api/2.0'

/** Box's ceiling for a single-request upload. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024

/** What a folder and a Box Note list as: Box gives neither a mime type. */
export const BOX_FOLDER_MIME = 'application/vnd.box.folder'
export const BOX_NOTE_MIME = 'application/vnd.box.boxnote'

/** The wait asked for after a 5xx, a dropped connection or a representation still rendering. */
export const TRANSIENT_RETRY_MS = 5000

const PAGE_MAX = 1000
const EVENTS_LIMIT = 500
/** Pages of events one `changes` call reads before handing back where it got to. */
export const EVENT_PAGES_MAX = 50

const ENTRY_FIELDS = 'id,type,name,size,modified_at,etag,parent'

/** Extension → mime, for the types a data room holds; anything else is octet-stream. */
const MIMES: { readonly [extension: string]: string } = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
  numbers: 'application/vnd.apple.numbers',
  pages: 'application/vnd.apple.pages',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  rtf: 'application/rtf',
  json: 'application/json',
  eml: 'message/rfc822',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  boxnote: BOX_NOTE_MIME,
}

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export const mimeOf = (name: string): string => {
  const extension = extensionOf(name)
  return Object.hasOwn(MIMES, extension)
    ? MIMES[extension]
    : 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// Box's JSON
// ---------------------------------------------------------------------------

const boxItem = z.object({
  type: z.string(),
  id: z.string(),
  name: z.string().optional(),
  size: z.number().nullable().optional(),
  modified_at: z.string().nullable().optional(),
  etag: z.string().nullable().optional(),
  /** Read only by `putFile`'s collision check; never surfaced. */
  sha1: z.string().nullable().optional(),
  parent: z.object({ id: z.string() }).nullable().optional(),
  item_status: z.string().optional(),
  extension: z.string().optional(),
  path_collection: z
    .object({
      entries: z.array(z.object({ id: z.string(), name: z.string() })),
    })
    .optional(),
})
type BoxItem = z.output<typeof boxItem>

const folderItems = z.object({
  entries: z.array(boxItem),
  next_marker: z.string().nullable().optional(),
})

const representation = z.object({
  representation: z.string(),
  info: z.object({ url: z.string() }),
  status: z.object({ state: z.string() }),
  content: z.object({ url_template: z.string() }),
})

const withRepresentations = z.object({
  representations: z.object({ entries: z.array(representation) }).optional(),
})

const eventPage = z.object({
  chunk_size: z.number(),
  entries: z.array(
    z.object({
      event_type: z.string(),
      source: z.unknown().optional(),
    }),
  ),
})

const errorBody = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
})

const conflictItem = z.object({
  type: z.string(),
  id: z.string(),
  name: z.string().optional(),
  sha1: z.string().nullable().optional(),
})
type Conflict = z.output<typeof conflictItem>

/** Box's 409: a folder create lists its conflicts, an upload names one. */
const nameInUse = z.object({
  code: z.literal('item_name_in_use'),
  context_info: z
    .object({
      conflicts: z.union([conflictItem, z.array(conflictItem)]),
    })
    .optional(),
})

const created = z.object({ id: z.string() })

const uploaded = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      file_version: z.object({ id: z.string() }),
    }),
  ),
})

/** Events that change the tree: the item as it now is, or gone. */
const CHANGED_EVENTS = new Set([
  'ITEM_CREATE',
  'ITEM_UPLOAD',
  'ITEM_MOVE',
  'ITEM_COPY',
  'ITEM_RENAME',
  'ITEM_UNDELETE_VIA_TRASH',
  'ITEM_MAKE_CURRENT_VERSION',
])
const REMOVED_EVENTS = new Set(['ITEM_TRASH'])

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Params = { readonly [name: string]: string | number | boolean | undefined }

export const boxUrl = (
  path: string,
  params: Params = {},
  base: string = BOX_API,
): string => {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) search.set(name, String(value))
  const query = search.toString()
  return `${base}${path}${query === '' ? '' : `?${query}`}`
}

/** Box's ids are digits; anything else names nothing and is never sent. */
const BOX_ID = /^\d+$/

/** A 403 that means the token no longer carries the scope. */
const AUTH_CODES = new Set(['insufficient_scope'])

const codeOf = (body: string): { code: string; message: string } => {
  try {
    const parsed = errorBody.safeParse(JSON.parse(body))
    if (parsed.success)
      return {
        code: parsed.data.code ?? '',
        message: parsed.data.message ?? '',
      }
  } catch {
    // Not JSON: a 401 has an empty body, and an edge page is HTML.
  }
  return { code: '', message: '' }
}

const retryAfterMs = (headers: HttpResponse['headers']): number => {
  const seconds = Number(headers['retry-after'])
  return Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : TRANSIENT_RETRY_MS
}

/** A non-2xx answer about `id`, as the port's typed failures. */
const failure = (
  response: HttpResponse,
  id: string,
  url: string,
): Effect.Effect<never, NotFound | RateLimited | AuthExpired> => {
  const { code, message } = codeOf(response.body)
  const { status } = response
  if (status === 401)
    return Effect.fail(new AuthExpired({ reason: 'Box refused the token' }))
  if (status === 429)
    return Effect.fail(
      new RateLimited({ retryAfterMs: retryAfterMs(response.headers) }),
    )
  if (status === 403 && AUTH_CODES.has(code))
    return Effect.fail(new AuthExpired({ reason: message || code }))
  // Any other 403 is an item this connection may not read: to it, not there.
  if (status === 403 || status === 404) return Effect.fail(new NotFound({ id }))
  if (status >= 500)
    return Effect.fail(new RateLimited({ retryAfterMs: TRANSIENT_RETRY_MS }))
  return Effect.die(
    new Error(`Box answered ${status} to ${url}: ${message || code}`),
  )
}

/** The Http port's failures as the storage port's: a transient one is retried later, like a 429. */
const fromPort = <TValue>(
  effect: Effect.Effect<TValue, JobError>,
): Effect.Effect<TValue, RateLimited> =>
  Effect.catchTags(effect, {
    JobRateLimited: (e) =>
      Effect.fail(new RateLimited({ retryAfterMs: e.retryAfterMs })),
    JobRetryable: () =>
      Effect.fail(new RateLimited({ retryAfterMs: TRANSIENT_RETRY_MS })),
    JobPermanent: (e) => Effect.die(new Error(`Box: ${e.reason}`)),
  })

const parse = <TSchema extends z.ZodType>(
  schema: TSchema,
  body: string,
  url: string,
) =>
  Effect.try({
    try: (): z.output<TSchema> => schema.parse(JSON.parse(body)),
    catch: (error) =>
      new Error(`Box answered ${url} with JSON it does not send`, {
        cause: error,
      }),
  }).pipe(Effect.orDie)

const readText = (stream: ReadableStream<Uint8Array>) =>
  Effect.promise(() => new Response(stream).text())

/**
 * `next_stream_position` read from the text: Box writes a 64-bit integer,
 * and `JSON.parse` would round it to a position that is not Box's.
 */
export const streamPositionOf = (body: string): string | null =>
  /"next_stream_position"\s*:\s*"?(\d+)"?/.exec(body)?.[1] ?? null

/** Box's `modified_at` (`…-08:00`) as UTC ISO; empty where Box sent none. */
const isoOf = (time: string | null | undefined): string => {
  if (time === null || time === undefined) return ''
  const ms = Date.parse(time)
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString()
}

/** A listed file or folder as the port's entry. `parentId` is where it was found. */
export const toEntry = (
  item: BoxItem,
  parentId: string | null,
): StorageEntry => {
  const modifiedAt = isoOf(item.modified_at)
  const name = item.name ?? ''
  const folder = item.type === 'folder'
  return {
    id: item.id,
    name,
    kind: folder ? 'folder' : 'file',
    mime: folder ? BOX_FOLDER_MIME : mimeOf(name),
    size: folder ? null : (item.size ?? null),
    modifiedAt,
    changeToken: item.etag ?? modifiedAt,
    parentId,
  }
}

const isFileOrFolder = (item: BoxItem) =>
  item.type === 'file' || item.type === 'folder'

const isRedirect = (status: number) =>
  status === 301 || status === 302 || status === 303 || status === 307

/** A Box Note's export name: `Memo.boxnote` → `Memo.txt`. */
const textName = (name: string) => `${name.replace(/\.boxnote$/i, '')}.txt`

/** Box compares names ignoring case. */
const nameKey = (name: string) => name.toLowerCase()

const sha1Of = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.promise(async () =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-1', bytes)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join(''),
  )

/** The conflict a 409 names, or null when the body says no name was in use. */
const conflictOf = (body: string): Conflict | null | 'unnamed' => {
  try {
    const parsed = nameInUse.safeParse(JSON.parse(body))
    if (!parsed.success) return null
    const conflicts = parsed.data.context_info?.conflicts
    if (conflicts === undefined) return 'unnamed'
    return (Array.isArray(conflicts) ? conflicts.at(0) : conflicts) ?? 'unnamed'
  } catch {
    return null
  }
}

/** `attributes` then `file`, the order Box requires. */
const multipartOf = (
  boundary: string,
  attributes: JsonObject,
  mime: string,
  bytes: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> => {
  const encoder = new TextEncoder()
  const head = encoder.encode(
    `--${boundary}\r\ncontent-disposition: form-data; name="attributes"\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(attributes)}\r\n--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="upload"\r\ncontent-type: ${mime}\r\n\r\n`,
  )
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(
    head.byteLength + bytes.byteLength + tail.byteLength,
  )
  body.set(head, 0)
  body.set(bytes, head.byteLength)
  body.set(tail, head.byteLength + bytes.byteLength)
  return body
}

/** An upload's bytes, whole: past `UPLOAD_MAX_BYTES` the stream is cancelled and the call dies. */
const readUpload = (stream: ReadableStream<Uint8Array>) =>
  Effect.suspend(() => {
    const reader = stream.getReader()
    return Effect.gen(function* () {
      const chunks: Array<Uint8Array> = []
      let size = 0
      for (;;) {
        const read = yield* Effect.promise(() => reader.read())
        if (read.done) break
        size += read.value.byteLength
        if (size > UPLOAD_MAX_BYTES)
          return yield* Effect.die(
            new Error(
              `Box takes at most ${UPLOAD_MAX_BYTES} bytes in one upload`,
            ),
          )
        chunks.push(read.value)
      }
      const bytes = new Uint8Array(size)
      let at = 0
      for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.byteLength
      }
      return bytes
    }).pipe(
      Effect.onError(() =>
        Effect.ignore(Effect.tryPromise(() => reader.cancel())),
      ),
    )
  })

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * The provider over the ports the host binds to this integration: what
 * `definePlugin({ storageSource })` hands core.
 */
export const boxSource = Effect.gen(function* () {
  const http = yield* Http
  const secrets = yield* Secrets

  const bearer = secrets.accessToken().pipe(
    Effect.map((token) => `Bearer ${Redacted.value(token)}`),
    Effect.mapError((e) => new AuthExpired({ reason: e.reason })),
  )

  /** One GET for JSON; the response whatever its status. */
  const get = (
    url: string,
    headers: { readonly [name: string]: string } = {},
  ) =>
    Effect.gen(function* () {
      const authorization = yield* bearer
      return yield* fromPort(
        http.request({
          method: 'GET',
          url,
          headers: { authorization, accept: 'application/json', ...headers },
        }),
      )
    })

  /** A write: a JSON or byte body, the response whatever its status. */
  const send = (
    method: HttpMethod,
    url: string,
    body: JsonObject | Uint8Array<ArrayBuffer>,
    headers: { readonly [name: string]: string } = {},
  ) =>
    Effect.gen(function* () {
      const authorization = yield* bearer
      return yield* fromPort(
        http.request({
          method,
          url,
          headers: {
            authorization,
            accept: 'application/json',
            ...(body instanceof Uint8Array
              ? {}
              : { 'content-type': 'application/json' }),
            ...headers,
          },
          body,
        }),
      )
    })

  /** One GET for JSON that must answer 200. */
  const getOk = <TSchema extends z.ZodType>(
    url: string,
    schema: TSchema,
    id: string,
    headers: { readonly [name: string]: string } = {},
  ) =>
    Effect.gen(function* () {
      const response = yield* get(url, headers)
      if (response.status !== 200) return yield* failure(response, id, url)
      return yield* parse(schema, response.body, url)
    })

  /** A GET whose body is handed over unread; `authorization` false for a pre-signed URL. */
  const stream = (url: string, authorization: boolean) =>
    Effect.gen(function* () {
      const headers = authorization ? { authorization: yield* bearer } : {}
      return yield* fromPort(http.stream({ method: 'GET', url, headers }))
    })

  /** A streamed answer that is not the bytes, read and failed as the port's. */
  const refused = (response: HttpStreamResponse, id: string, url: string) =>
    Effect.gen(function* () {
      const body = yield* readText(response.body)
      if (response.status === 202)
        return yield* new RateLimited({
          retryAfterMs: retryAfterMs(response.headers),
        })
      return yield* failure({ ...response, body }, id, url)
    })

  const item = (kind: 'folders' | 'files', id: string, fields: string) =>
    BOX_ID.test(id)
      ? getOk(boxUrl(`/${kind}/${id}`, { fields }), boxItem, id)
      : Effect.fail(new NotFound({ id }))

  const resolveLink = Effect.fn('box.resolveLink')(function* (url: string) {
    const link = parseBoxLink(url)
    if (link === null) return null
    if (link.kind !== 'shared') {
      // The link's form says which; Box says whether it is there.
      const found = yield* item(
        link.kind === 'folder' ? 'folders' : 'files',
        link.id,
        'id',
      )
      const target: LinkTarget =
        link.kind === 'folder' ? { folderId: found.id } : { fileId: found.id }
      return target
    }
    const shared = yield* getOk(
      boxUrl('/shared_items', { fields: 'id,type' }),
      boxItem,
      link.url,
      { boxapi: `shared_link=${link.url}` },
    )
    // A shared web link is a bookmark: no bytes for this port to deliver.
    if (!isFileOrFolder(shared)) return yield* new NotFound({ id: shared.id })
    const target: LinkTarget =
      shared.type === 'folder' ? { folderId: shared.id } : { fileId: shared.id }
    return target
  })

  /** One page of `folders/:id/items`: Box's own entries and its next marker. */
  const itemsPage = (
    folderId: string,
    limit: number,
    marker?: string,
    fields: string = ENTRY_FIELDS,
  ) =>
    Effect.gen(function* () {
      const url = boxUrl(`/folders/${folderId}/items`, {
        fields,
        usemarker: true,
        limit,
        marker,
      })
      const response = yield* get(url)
      if (response.status === 400 && marker !== undefined)
        return yield* new CursorExpired({ cursor: marker })
      if (response.status !== 200)
        return yield* failure(response, folderId, url)
      const page = yield* parse(folderItems, response.body, url)
      const next =
        page.next_marker === null ||
        page.next_marker === undefined ||
        page.next_marker === ''
          ? undefined
          : page.next_marker
      return { entries: page.entries, next }
    })

  /**
   * Box lists folders, then files, then web links. A web link is a
   * bookmark with no bytes: it is left out, and the first one ends the
   * listing, since nothing after it is a file or folder.
   */
  const listFolder = Effect.fn('box.listFolder')(function* (
    folderId: string,
    options: ListFolderOptions = {},
  ) {
    if (!BOX_ID.test(folderId)) return yield* new NotFound({ id: folderId })
    const limit = Math.min(PAGE_MAX, Math.max(1, options.pageSize ?? 100))
    const page = yield* itemsPage(folderId, limit, options.cursor)
    const kept = page.entries.filter(isFileOrFolder)
    const next = kept.length < page.entries.length ? undefined : page.next
    const result: FolderPage = {
      entries: kept.map((entry) => toEntry(entry, folderId)),
      ...(next === undefined ? {} : { next }),
    }
    return result
  })

  const getFolder = Effect.fn('box.getFolder')(function* (folderId: string) {
    const folder = yield* item('folders', folderId, 'id,name,path_collection')
    const result: StorageFolder = {
      id: folder.id,
      name: folder.name ?? '',
      parents: (folder.path_collection?.entries ?? []).map((p) => ({
        id: p.id,
        name: p.name,
      })),
    }
    return result
  })

  /**
   * A Box Note's text: its `extracted_text` representation. One status
   * check moves a pending one along; still rendering after it is a wait,
   * and a note Box cannot extract has no bytes to give.
   */
  const noteText = (fileId: string) =>
    Effect.gen(function* () {
      const url = boxUrl(`/files/${fileId}`, { fields: 'representations' })
      const meta = yield* getOk(url, withRepresentations, fileId, {
        'x-rep-hints': '[extracted_text]',
      })
      let rep = (meta.representations?.entries ?? []).find(
        (r) => r.representation === 'extracted_text',
      )
      if (rep === undefined) return yield* new NotFound({ id: fileId })
      if (rep.status.state === 'pending' || rep.status.state === 'none')
        rep = yield* getOk(rep.info.url, representation, fileId)
      if (rep.status.state === 'error')
        return yield* new NotFound({ id: fileId })
      if (rep.status.state !== 'success' && rep.status.state !== 'viewable')
        return yield* new RateLimited({ retryAfterMs: TRANSIENT_RETRY_MS })
      const contentUrl = rep.content.url_template.replace('{+asset_path}', '')
      const response = yield* stream(contentUrl, true)
      if (response.status !== 200)
        return yield* refused(response, fileId, contentUrl)
      return response.body
    })

  /** A file's bytes: Box answers its content URL with a redirect to a pre-signed download. */
  const content = (fileId: string) =>
    Effect.gen(function* () {
      const url = boxUrl(`/files/${fileId}/content`)
      let response = yield* stream(url, true)
      let at = url
      if (isRedirect(response.status)) {
        yield* Effect.promise(() => response.body.cancel())
        const location = Object.hasOwn(response.headers, 'location')
          ? response.headers.location
          : undefined
        if (location === undefined)
          return yield* Effect.die(
            new Error(`Box redirected ${url} to nowhere`),
          )
        // Pre-signed: the token stays with Box's own API.
        at = location
        response = yield* stream(location, false)
      }
      if (response.status !== 200) return yield* refused(response, fileId, at)
      return response.body
    })

  const getFile = Effect.fn('box.getFile')(function* (fileId: string) {
    const meta = yield* item(
      'files',
      fileId,
      'id,name,etag,modified_at,parent,extension',
    )
    const name = meta.name ?? ''
    const note = (meta.extension ?? extensionOf(name)) === 'boxnote'
    const body = note ? yield* noteText(fileId) : yield* content(fileId)
    const file: StorageFile = {
      stream: body,
      mime: note ? 'text/plain' : mimeOf(name),
      name: note ? textName(name) : name,
      changeToken: meta.etag ?? isoOf(meta.modified_at),
      parentId: meta.parent?.id ?? null,
    }
    return file
  })

  /** One page of the events stream from `position`, and where it ends. */
  const eventsFrom = (position: string, cursor: string) =>
    Effect.gen(function* () {
      const url = boxUrl('/events', {
        stream_position: position,
        stream_type: 'changes',
        limit: EVENTS_LIMIT,
      })
      const response = yield* get(url)
      // Box no longer holds this position: re-list the subtree.
      if ([400, 404, 410].includes(response.status))
        return yield* new CursorExpired({ cursor })
      if (response.status !== 200)
        return yield* failure(response, 'events', url).pipe(
          Effect.catchTag('NotFound', () =>
            Effect.fail(new CursorExpired({ cursor })),
          ),
        )
      const next = streamPositionOf(response.body)
      if (next === null)
        return yield* Effect.die(
          new Error(`Box answered ${url} with no next_stream_position`),
        )
      const page = yield* parse(eventPage, response.body, url)
      return { page, next }
    })

  /** An event as a change; null when it touches no file or folder, or is not a tree change. */
  const changeOf = (
    eventType: string,
    source: unknown,
  ): StorageChange | null => {
    const parsed = boxItem.safeParse(source)
    if (!parsed.success || !isFileOrFolder(parsed.data)) return null
    const changed = parsed.data
    const gone =
      REMOVED_EVENTS.has(eventType) ||
      (changed.item_status !== undefined && changed.item_status !== 'active')
    if (gone) return { _tag: 'removed', id: changed.id }
    if (!CHANGED_EVENTS.has(eventType)) return null
    return {
      _tag: 'changed',
      entry: toEntry(changed, changed.parent?.id ?? null),
    }
  }

  const changes = Effect.fn('box.changes')(function* (cursor: string | null) {
    if (cursor === null) {
      const url = boxUrl('/events', { stream_position: 'now' })
      const response = yield* get(url)
      if (response.status !== 200)
        return yield* failure(response, 'events', url).pipe(
          Effect.catchTag('NotFound', () =>
            Effect.die(new Error('Box has no events stream for this token')),
          ),
        )
      const next = streamPositionOf(response.body)
      if (next === null)
        return yield* Effect.die(
          new Error(`Box answered ${url} with no next_stream_position`),
        )
      const start: ChangePage = { changes: [], next }
      return start
    }
    if (!/^\d+$/.test(cursor)) return yield* new CursorExpired({ cursor })
    // The latest state per id, in the order each id last changed; Box may repeat an event.
    const latest = new Map<string, StorageChange>()
    let position = cursor
    for (let pages = 0; pages < EVENT_PAGES_MAX; pages++) {
      const { page, next } = yield* eventsFrom(position, cursor)
      for (const event of page.entries) {
        const change = changeOf(event.event_type, event.source)
        if (change === null) continue
        const id = change._tag === 'changed' ? change.entry.id : change.id
        latest.delete(id)
        latest.set(id, change)
      }
      position = next
      if (page.chunk_size === 0) break
    }
    const result: ChangePage = { changes: [...latest.values()], next: position }
    return result
  })

  /**
   * What web's picker host opens Box's Content Picker with; never a token
   * or a secret. Only for a connection Box still accepts: a refused token
   * is `AuthExpired`, and anything short of a refusal (a 429, a 5xx) is not.
   */
  const pickerConfig = Effect.fn('box.pickerConfig')(function* () {
    const url = boxUrl('/users/me', { fields: 'id' })
    const response = yield* get(url).pipe(
      Effect.catchTag('RateLimited', () => Effect.succeed(null)),
    )
    if (response?.status === 401)
      return yield* new AuthExpired({ reason: 'Box refused the token' })
    const config: PickerConfig = {
      provider: 'box',
      picker: 'ContentPicker',
      scriptUrl:
        'https://cdn01.boxcdn.net/platform/elements/23.0.0/en-US/picker.js',
      stylesheetUrl:
        'https://cdn01.boxcdn.net/platform/elements/23.0.0/en-US/picker.css',
      rootFolderId: '0',
      scopes: ['root_readonly'],
      types: ['file', 'folder'],
      multiselect: true,
    }
    return config
  })

  // -------------------------------------------------------------------------
  // The write half
  // -------------------------------------------------------------------------

  /** Every item in a folder by name, ignoring case: what the collision check reads. */
  const namesIn = (folderId: string) =>
    Effect.gen(function* () {
      const taken = new Map<string, Conflict>()
      let marker: string | undefined
      do {
        const page = yield* itemsPage(
          folderId,
          PAGE_MAX,
          marker,
          'id,type,name,sha1',
        ).pipe(
          // A marker from this very walk cannot be stale; Box changed under it.
          Effect.catchTag('CursorExpired', () =>
            Effect.fail(new RateLimited({ retryAfterMs: TRANSIENT_RETRY_MS })),
          ),
        )
        for (const entry of page.entries)
          taken.set(nameKey(entry.name ?? ''), {
            type: entry.type,
            id: entry.id,
            sha1: entry.sha1 ?? null,
          })
        marker = page.next
      } while (marker !== undefined)
      return taken
    })

  /**
   * The child folder `name`, made when absent. Box refuses a second folder
   * under one name, so a create that loses a race answers 409 naming the
   * winner, and every caller ends with the same id.
   */
  const ensureChild = (parentId: string, name: string) =>
    Effect.gen(function* () {
      const url = boxUrl('/folders', { fields: 'id' })
      const response = yield* send('POST', url, {
        name,
        parent: { id: parentId },
      })
      if (response.status === 201 || response.status === 200)
        return (yield* parse(created, response.body, url)).id
      if (response.status !== 409)
        return yield* failure(response, parentId, url)
      const conflict = conflictOf(response.body)
      if (conflict === null) return yield* failure(response, parentId, url)
      const holder =
        conflict === 'unnamed'
          ? (yield* namesIn(parentId)).get(nameKey(name))
          : conflict
      if (holder?.type !== 'folder')
        return yield* Effect.die(
          new Error(
            `Box holds a ${holder?.type ?? 'missing item'} named ${name} in ${parentId}, not a folder`,
          ),
        )
      return holder.id
    })

  const ensureFolder = Effect.fn('box.ensureFolder')(function* (
    rootId: string,
    path: string,
  ) {
    yield* item('folders', rootId, 'id')
    let at = rootId
    for (const name of pathSegments(path)) at = yield* ensureChild(at, name)
    return at
  })

  /** One upload: a new file in a folder, or a new version of a file. 409 hands back what holds the name. */
  const upload = (
    target: { readonly folderId: string } | { readonly fileId: string },
    name: string,
    content: { readonly mime: string; readonly sha1: string },
    bytes: Uint8Array<ArrayBuffer>,
  ) =>
    Effect.gen(function* () {
      const version = 'fileId' in target
      const id = version ? target.fileId : target.folderId
      const url = boxUrl(
        version ? `/files/${target.fileId}/content` : '/files/content',
        { fields: 'id,name,file_version' },
        BOX_UPLOAD,
      )
      const boundary = `spaces-${crypto.randomUUID()}`
      const attributes: JsonObject = version
        ? {}
        : { name, parent: { id: target.folderId } }
      const response = yield* send(
        'POST',
        url,
        multipartOf(boundary, attributes, content.mime, bytes),
        {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          // Box checks the bytes it stored against this SHA-1.
          'content-md5': content.sha1,
        },
      )
      if (response.status === 409) {
        const conflict = conflictOf(response.body)
        if (conflict !== null && conflict !== 'unnamed')
          return { _tag: 'taken' as const, conflict }
      }
      if (response.status !== 201 && response.status !== 200)
        return yield* failure(response, id, url)
      const file = (yield* parse(uploaded, response.body, url)).entries.at(0)
      if (file === undefined)
        return yield* Effect.die(new Error(`Box answered ${url} with no file`))
      const result: PutFileResult = {
        fileId: file.id,
        revisionId: file.file_version.id,
        name: file.name,
      }
      return { _tag: 'put' as const, result }
    })

  /** Past this many names taken, the folder is not one a person keeps. */
  const COLLISION_LIMIT = 1000

  const putFile = Effect.fn('box.putFile')(function* (
    folderId: string,
    name: string,
    content: StorageUpload,
  ) {
    if (!BOX_ID.test(folderId)) return yield* new NotFound({ id: folderId })
    const bytes = yield* readUpload(content.stream)
    const sha1 = yield* sha1Of(bytes)
    yield* item('folders', folderId, 'id')
    const taken = yield* namesIn(folderId)
    const into = { mime: content.mime, sha1 }
    for (let n = 1; n <= COLLISION_LIMIT;) {
      const tried = collisionName(name, n)
      const holder = taken.get(nameKey(tried))
      // Same bytes: a version of that file. Anything else: the next name.
      if (
        holder !== undefined &&
        (holder.type !== 'file' || holder.sha1 !== sha1)
      ) {
        n++
        continue
      }
      const landed = yield* upload(
        holder === undefined ? { folderId } : { fileId: holder.id },
        tried,
        into,
        bytes,
      )
      if (landed._tag === 'put') return landed.result
      // A racing upload took the name first: judge the same name again.
      taken.set(nameKey(tried), landed.conflict)
    }
    return yield* Effect.die(
      new Error(`${folderId} holds ${COLLISION_LIMIT} files named ${name}`),
    )
  })

  /** A file or a folder by id: Box keeps the two apart, so a file is asked for first. */
  const either = (id: string) =>
    item('files', id, 'id,name,parent').pipe(
      Effect.map((found) => ({ kind: 'files' as const, found })),
      Effect.catchTag('NotFound', () =>
        item('folders', id, 'id,name,parent').pipe(
          Effect.map((found) => ({ kind: 'folders' as const, found })),
        ),
      ),
    )

  /** A `PUT` of a file or folder's `name` or `parent`. */
  const change = (kind: 'files' | 'folders', id: string, body: JsonObject) =>
    Effect.gen(function* () {
      const url = boxUrl(`/${kind}/${id}`, { fields: 'id' })
      const response = yield* send('PUT', url, body)
      if (response.status !== 200) return yield* failure(response, id, url)
    })

  const move = Effect.fn('box.move')(function* (id: string, folderId: string) {
    const { kind, found } = yield* either(id)
    if (found.parent?.id === folderId) return
    yield* item('folders', folderId, 'id')
    yield* change(kind, id, { parent: { id: folderId } })
  })

  const rename = Effect.fn('box.rename')(function* (id: string, name: string) {
    const { kind, found } = yield* either(id)
    if (found.name === name) return
    yield* change(kind, id, { name })
  })

  const source: WritableStorageSource = {
    resolveLink,
    listFolder,
    getFolder,
    getFile,
    changes,
    pickerConfig,
    ensureFolder,
    putFile,
    move,
    rename,
  }
  return source
})
