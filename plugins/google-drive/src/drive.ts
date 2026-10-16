import { Effect, Option, Predicate, Redacted } from 'effect'
import { z } from 'zod'
import {
  AuthExpired,
  Config,
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
  FolderRef,
  HttpMethod,
  HttpResponse,
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
import { parseDriveLink } from './links.ts'

/**
 * The storage-source port over Drive's v3 REST API: every request through
 * the Http port, with a bearer token from `Secrets.accessToken()` fetched
 * per call so a refreshed token is always the one sent.
 *
 * - Bytes are streamed through, never buffered. Native Docs, Sheets and
 *   Slides are exported (docx, xlsx, pdf); every other file is `alt=media`.
 * - `changeToken` is Drive's `version`, else `modifiedTime` — never a hash.
 *   An export is not byte-stable (the docx zip carries timestamps), so a
 *   re-export of an unchanged Doc is new bytes under the same token.
 * - A failure the port's types cannot name — Drive answering a request this
 *   code built wrong, or JSON that is not Drive's — is a defect, not a guess.
 * - Writes upload in resumable chunks of `UPLOAD_CHUNK_BYTES`: one chunk is
 *   all a `putFile` holds, whatever the file's size.
 */

export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'

/** Bytes per resumable chunk. Drive wants every chunk but the last a multiple of 256 KiB. */
export const UPLOAD_CHUNK_BYTES = 32 * 256 * 1024
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
const NATIVE_PREFIX = 'application/vnd.google-apps.'

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** What each native type exports to. A native type not here has no bytes to give. */
export const EXPORTS: {
  readonly [native: string]: {
    readonly mime: string
    readonly extension: string
  }
} = {
  'application/vnd.google-apps.document': {
    mime: DOCX_MIME,
    extension: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mime: XLSX_MIME,
    extension: 'xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mime: 'application/pdf',
    extension: 'pdf',
  },
}

/** The wait asked for after a 5xx or a dropped connection: Drive says back off, and names no time. */
export const TRANSIENT_RETRY_MS = 5000

/** Drive's page size ceiling, for both listings and changes. */
const PAGE_MAX = 1000

const ENTRY_FIELDS = 'id,name,mimeType,parents,size,modifiedTime,version'

// ---------------------------------------------------------------------------
// Drive's JSON
// ---------------------------------------------------------------------------

const driveFile = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  parents: z.array(z.string()).optional(),
  size: z.string().optional(),
  modifiedTime: z.string().optional(),
  version: z.string().optional(),
  trashed: z.boolean().optional(),
  createdTime: z.string().optional(),
  headRevisionId: z.string().optional(),
  sha256Checksum: z.string().optional(),
})
type DriveFile = z.output<typeof driveFile>

const fileList = z.object({
  files: z.array(driveFile),
  nextPageToken: z.string().optional(),
})

const changeList = z.object({
  changes: z.array(
    z.object({
      changeType: z.string().optional(),
      fileId: z.string().optional(),
      removed: z.boolean().optional(),
      file: driveFile.optional(),
    }),
  ),
  nextPageToken: z.string().optional(),
  newStartPageToken: z.string().optional(),
})

const startToken = z.object({ startPageToken: z.string() })

const driveList = z.object({
  drives: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
})

const errorBody = z.object({
  error: z.object({
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string() })).optional(),
  }),
})

/** The cursor `changes` hands out: one Drive page token per drive it reads. */
const cursorSchema = z.object({
  v: z.literal(1),
  myDrive: z.string(),
  drives: z.record(z.string(), z.string()),
})
type Cursor = z.output<typeof cursorSchema>

const encodeCursor = (cursor: Cursor): string => JSON.stringify(cursor)

const decodeCursor = (text: string): Cursor | null => {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Params = { readonly [name: string]: string | number | boolean | undefined }

export const driveUrl = (
  path: string,
  params: Params = {},
  base = DRIVE_API,
): string => {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) search.set(name, String(value))
  const query = search.toString()
  return `${base}${path}${query === '' ? '' : `?${query}`}`
}

/** A string literal in Drive's `q` grammar. */
export const quoted = (text: string) =>
  `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** Oldest first: created time, then id. Every caller racing on one name agrees on the first. */
const byAge = (a: DriveFile, b: DriveFile) => {
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
  return order(a.createdTime ?? '', b.createdTime ?? '') || order(a.id, b.id)
}

const fileUrl = (id: string, suffix = '') =>
  `/files/${encodeURIComponent(id)}${suffix}`

/** Drive's rate-limit reasons, which it may send as a 403 rather than a 429. */
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])

/** A 403 that means the token no longer carries what it needs. */
const AUTH_REASONS = new Set([
  'authError',
  'insufficientScopes',
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
])

const reasonOf = (body: string): { reason: string; message: string } => {
  try {
    const parsed = errorBody.safeParse(JSON.parse(body))
    if (parsed.success)
      return {
        reason: parsed.data.error.errors?.at(0)?.reason ?? '',
        message: parsed.data.error.message ?? '',
      }
  } catch {
    // Not JSON: Drive's HTML error pages carry no reason.
  }
  return { reason: '', message: '' }
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
  const { reason, message } = reasonOf(response.body)
  const { status } = response
  if (status === 401)
    return Effect.fail(
      new AuthExpired({ reason: message || 'Drive refused the token' }),
    )
  if (status === 429 || (status === 403 && RATE_REASONS.has(reason)))
    return Effect.fail(
      new RateLimited({ retryAfterMs: retryAfterMs(response.headers) }),
    )
  if (status === 403 && AUTH_REASONS.has(reason))
    return Effect.fail(new AuthExpired({ reason: message || reason }))
  // Any other 403 is a file this connection may not read: to it, not there.
  if (status === 403 || status === 404) return Effect.fail(new NotFound({ id }))
  if (status >= 500)
    return Effect.fail(new RateLimited({ retryAfterMs: TRANSIENT_RETRY_MS }))
  return Effect.die(
    new Error(
      `Google Drive answered ${status} to ${url}: ${message || reason}`,
    ),
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
    JobPermanent: (e) => Effect.die(new Error(`Google Drive: ${e.reason}`)),
  })

const parse = <TSchema extends z.ZodType>(
  schema: TSchema,
  body: string,
  url: string,
) =>
  Effect.try({
    try: (): z.output<TSchema> => schema.parse(JSON.parse(body)),
    catch: (error) =>
      new Error(`Google Drive answered ${url} with JSON it does not send`, {
        cause: error,
      }),
  }).pipe(Effect.orDie)

const readText = (stream: ReadableStream<Uint8Array>) =>
  Effect.promise(() => new Response(stream).text())

const withExtension = (name: string, extension: string) =>
  name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`

/** A listed file as the port's entry. `parentId` is where it was found. */
export const toEntry = (
  file: DriveFile,
  parentId: string | null,
): StorageEntry => {
  const modifiedAt = file.modifiedTime ?? ''
  return {
    id: file.id,
    name: file.name,
    kind: file.mimeType === FOLDER_MIME ? 'folder' : 'file',
    mime: file.mimeType,
    size: file.size === undefined ? null : Number(file.size),
    modifiedAt,
    changeToken: file.version ?? modifiedAt,
    parentId,
  }
}

/** Ids reach a `q` string and a path: anything but Drive's alphabet is no id at all. */
const DRIVE_ID = /^[\w-]+$/

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * The provider over the ports the host binds to this integration: what
 * `definePlugin({ storageSource })` hands core.
 */
export const driveSource = Effect.gen(function* () {
  const http = yield* Http
  const secrets = yield* Secrets
  // Read for the picker only; a provider built without it still reads Drive.
  const settings = yield* Effect.serviceOption(Config)

  const bearer = secrets.accessToken().pipe(
    Effect.map((token) => `Bearer ${Redacted.value(token)}`),
    Effect.mapError((e) => new AuthExpired({ reason: e.reason })),
  )

  /** One request; the response whatever its status. */
  const send = (
    method: HttpMethod,
    url: string,
    body?: JsonObject | Uint8Array<ArrayBuffer>,
    headers: { readonly [name: string]: string } = {},
  ) =>
    Effect.gen(function* () {
      const authorization = yield* bearer
      return yield* fromPort(
        http.request({
          method,
          url,
          headers: { authorization, accept: 'application/json', ...headers },
          ...(body === undefined ? {} : { body }),
        }),
      )
    })

  /** One GET for JSON; the response whatever its status. */
  const get = (url: string) => send('GET', url)

  /** One GET for JSON that must answer 200. */
  const getOk = <TSchema extends z.ZodType>(
    url: string,
    schema: TSchema,
    id: string,
  ) =>
    Effect.gen(function* () {
      const response = yield* get(url)
      if (response.status !== 200) return yield* failure(response, id, url)
      return yield* parse(schema, response.body, url)
    })

  const metadata = (id: string, fields: string) =>
    DRIVE_ID.test(id)
      ? getOk(
          driveUrl(fileUrl(id), { fields, supportsAllDrives: true }),
          driveFile,
          id,
        )
      : Effect.fail(new NotFound({ id }))

  const resolveLink = Effect.fn('googleDrive.resolveLink')(function* (
    url: string,
  ) {
    const link = parseDriveLink(url)
    if (link === null) return null
    // The link's form is a hint; Drive says what the id names.
    const meta = yield* metadata(link.id, 'id,name,mimeType')
    const target: LinkTarget =
      meta.mimeType === FOLDER_MIME
        ? { folderId: meta.id }
        : { fileId: meta.id }
    return target
  })

  const listFolder = Effect.fn('googleDrive.listFolder')(function* (
    folderId: string,
    options: ListFolderOptions = {},
  ) {
    // A listing of a missing parent is an empty 200: ask once, on page one.
    if (options.cursor === undefined) {
      const meta = yield* metadata(folderId, 'id,name,mimeType')
      if (meta.mimeType !== FOLDER_MIME)
        return yield* new NotFound({ id: folderId })
    }
    const url = driveUrl('/files', {
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken,files(${ENTRY_FIELDS})`,
      pageSize: Math.min(PAGE_MAX, Math.max(1, options.pageSize ?? 100)),
      pageToken: options.cursor,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    const response = yield* get(url)
    if (response.status === 400 && options.cursor !== undefined)
      return yield* new CursorExpired({ cursor: options.cursor })
    if (response.status !== 200) return yield* failure(response, folderId, url)
    const list = yield* parse(fileList, response.body, url)
    const page: FolderPage = {
      entries: list.files.map((file) => toEntry(file, folderId)),
      ...(list.nextPageToken === undefined ? {} : { next: list.nextPageToken }),
    }
    return page
  })

  const getFolder = Effect.fn('googleDrive.getFolder')(function* (
    folderId: string,
  ) {
    const fields = 'id,name,mimeType,parents'
    const folder = yield* metadata(folderId, fields)
    if (folder.mimeType !== FOLDER_MIME)
      return yield* new NotFound({ id: folderId })
    const parents: Array<FolderRef> = []
    const seen = new Set([folder.id])
    let up = folder.parents?.at(0)
    while (up !== undefined && !seen.has(up)) {
      seen.add(up)
      // An ancestor this connection cannot see (drive.file) heads the chain.
      const parent = yield* metadata(up, fields).pipe(
        Effect.catchTag('NotFound', () => Effect.succeed(null)),
      )
      if (parent === null) break
      parents.unshift({ id: parent.id, name: parent.name })
      up = parent.parents?.at(0)
    }
    const result: StorageFolder = { id: folder.id, name: folder.name, parents }
    return result
  })

  const getFile = Effect.fn('googleDrive.getFile')(function* (fileId: string) {
    const meta = yield* metadata(
      fileId,
      'id,name,mimeType,version,modifiedTime,parents',
    )
    const target = Object.hasOwn(EXPORTS, meta.mimeType)
      ? EXPORTS[meta.mimeType]
      : undefined
    // A folder, a Form or a shortcut has no bytes to hand over.
    if (target === undefined && meta.mimeType.startsWith(NATIVE_PREFIX))
      return yield* new NotFound({ id: fileId })
    const url =
      target === undefined
        ? driveUrl(fileUrl(fileId), { alt: 'media', supportsAllDrives: true })
        : driveUrl(fileUrl(fileId, '/export'), { mimeType: target.mime })
    const authorization = yield* bearer
    const response = yield* fromPort(
      http.stream({ method: 'GET', url, headers: { authorization } }),
    )
    if (response.status !== 200) {
      const body = yield* readText(response.body)
      return yield* failure({ ...response, body }, fileId, url)
    }
    const file: StorageFile = {
      stream: response.body,
      mime: target?.mime ?? meta.mimeType,
      name:
        target === undefined
          ? meta.name
          : withExtension(meta.name, target.extension),
      changeToken: meta.version ?? meta.modifiedTime ?? '',
      parentId: meta.parents?.at(0) ?? null,
    }
    return file
  })

  /**
   * The shared drives this connection sees. A token without a drive-wide
   * scope (drive.file) may not list them: then there are none to read.
   */
  const sharedDrives = Effect.gen(function* () {
    const ids: Array<string> = []
    let pageToken: string | undefined
    do {
      const url = driveUrl('/drives', {
        pageSize: 100,
        pageToken,
        fields: 'nextPageToken,drives(id)',
      })
      const response = yield* get(url)
      const refused =
        (response.status === 403 &&
          !RATE_REASONS.has(reasonOf(response.body).reason)) ||
        response.status === 404
      if (refused) return []
      if (response.status !== 200)
        return yield* failure(response, 'drives', url).pipe(
          Effect.catchTag('NotFound', () => Effect.succeed([])),
        )
      const page = yield* parse(driveList, response.body, url)
      ids.push(...(page.drives ?? []).map((d) => d.id))
      pageToken = page.nextPageToken
    } while (pageToken !== undefined)
    return ids
  })

  /** A drive's starting page token: My Drive's when `driveId` is null. */
  const startPageToken = (driveId: string | null) =>
    Effect.gen(function* () {
      const url = driveUrl(
        '/changes/startPageToken',
        driveId === null ? {} : { driveId, supportsAllDrives: true },
      )
      const response = yield* get(url)
      if (response.status !== 200)
        return yield* failure(response, driveId ?? 'my-drive', url)
      return (yield* parse(startToken, response.body, url)).startPageToken
    })

  /** A shared drive's starting token; null when it is no longer visible. */
  const sharedStart = (driveId: string) =>
    startPageToken(driveId).pipe(
      Effect.catchTag('NotFound', () => Effect.succeed(null)),
    )

  const myDriveStart = startPageToken(null).pipe(
    Effect.catchTag('NotFound', () =>
      Effect.die(new Error('Google Drive has no My Drive for this connection')),
    ),
  )

  /**
   * One drive's changes from `pageToken` to now, every page. A shared drive
   * is named with `driveId` and the two all-drives flags; My Drive sends
   * none of them, nor a `corpora`.
   */
  const drain = (pageToken: string, driveId: string | null, cursor: string) =>
    Effect.gen(function* () {
      const changes: Array<StorageChange> = []
      let token = pageToken
      for (;;) {
        const url = driveUrl('/changes', {
          pageToken: token,
          pageSize: PAGE_MAX,
          fields: `nextPageToken,newStartPageToken,changes(changeType,fileId,removed,file(${ENTRY_FIELDS},trashed))`,
          ...(driveId === null
            ? {}
            : {
                driveId,
                includeItemsFromAllDrives: true,
                supportsAllDrives: true,
              }),
        })
        const response = yield* get(url)
        // 410: Drive no longer honours the token. 404: the drive is gone.
        if (response.status === 410 || response.status === 404)
          return yield* new CursorExpired({ cursor })
        if (response.status !== 200)
          return yield* failure(response, driveId ?? 'my-drive', url).pipe(
            Effect.catchTag('NotFound', () =>
              Effect.fail(new CursorExpired({ cursor })),
            ),
          )
        const page = yield* parse(changeList, response.body, url)
        for (const change of page.changes) {
          if (change.changeType === 'drive' || change.fileId === undefined)
            continue
          const { file } = change
          changes.push(
            change.removed === true || file === undefined || file.trashed
              ? { _tag: 'removed', id: change.fileId }
              : {
                  _tag: 'changed',
                  entry: toEntry(file, file.parents?.at(0) ?? null),
                },
          )
        }
        if (page.newStartPageToken !== undefined)
          return { changes, next: page.newStartPageToken }
        if (page.nextPageToken === undefined)
          return yield* Effect.die(
            new Error(
              `Google Drive's ${url} named neither a next page nor a new start`,
            ),
          )
        token = page.nextPageToken
      }
    })

  const changes = Effect.fn('googleDrive.changes')(function* (
    cursor: string | null,
  ) {
    const drives = yield* sharedDrives
    const next: { [driveId: string]: string } = {}
    if (cursor === null) {
      const myDrive = yield* myDriveStart
      for (const id of drives) {
        const start = yield* sharedStart(id)
        if (start !== null) next[id] = start
      }
      const page: ChangePage = {
        changes: [],
        next: encodeCursor({ v: 1, myDrive, drives: next }),
      }
      return page
    }
    const state = decodeCursor(cursor)
    if (state === null) return yield* new CursorExpired({ cursor })
    // The latest state per id, in the order each id last changed.
    const latest = new Map<string, StorageChange>()
    const take = (list: ReadonlyArray<StorageChange>) => {
      for (const change of list) {
        const id = change._tag === 'changed' ? change.entry.id : change.id
        latest.delete(id)
        latest.set(id, change)
      }
    }
    const mine = yield* drain(state.myDrive, null, cursor)
    take(mine.changes)
    // A drive joined since the last call starts now; one left is dropped.
    for (const id of drives) {
      const from = Object.hasOwn(state.drives, id)
        ? state.drives[id]
        : undefined
      if (from === undefined) {
        const start = yield* sharedStart(id)
        if (start !== null) next[id] = start
        continue
      }
      const theirs = yield* drain(from, id, cursor)
      take(theirs.changes)
      next[id] = theirs.next
    }
    const page: ChangePage = {
      changes: [...latest.values()],
      next: encodeCursor({ v: 1, myDrive: mine.next, drives: next }),
    }
    return page
  })

  /**
   * What web's picker host loads Google's picker with; never a token or a
   * secret. Only for a connection Drive still accepts: a refused token is
   * `AuthExpired`, and anything short of a refusal (a 429, a 5xx) is not.
   * - `developerKey` and `appId` come from the row's `pickerApiKey` and
   *   `pickerAppId`, and are left out while unset.
   */
  const pickerConfig = Effect.fn('googleDrive.pickerConfig')(function* () {
    const url = driveUrl('/about', { fields: 'kind' })
    const response = yield* get(url).pipe(
      Effect.catchTag('RateLimited', () => Effect.succeed(null)),
    )
    if (response?.status === 401)
      return yield* new AuthExpired({
        reason: reasonOf(response.body).message || 'Drive refused the token',
      })
    const row = Option.isSome(settings) ? yield* settings.value.get() : {}
    const filled = (key: string) => {
      const value = row[key]
      return Predicate.isString(value) && value !== '' ? value : null
    }
    const developerKey = filled('pickerApiKey')
    const appId = filled('pickerAppId')
    const config: PickerConfig = {
      provider: 'google-drive',
      scriptUrl: 'https://apis.google.com/js/api.js',
      scopes: ['drive.file'],
      views: ['DOCS', 'FOLDERS'],
      supportsSharedDrives: true,
      multiselect: true,
      ...(developerKey === null ? {} : { developerKey }),
      ...(appId === null ? {} : { appId }),
    }
    return config
  })

  // -------------------------------------------------------------------------
  // The write half
  // -------------------------------------------------------------------------

  const folderOnly = (id: string) =>
    Effect.gen(function* () {
      const meta = yield* metadata(id, 'id,name,mimeType')
      if (meta.mimeType !== FOLDER_MIME) return yield* new NotFound({ id })
    })

  /** Every live child of a folder that `clauses` match, oldest first. */
  const search = (folderId: string, clauses: string, fields: string) =>
    Effect.gen(function* () {
      const files: Array<DriveFile> = []
      let pageToken: string | undefined
      do {
        const url = driveUrl('/files', {
          q: `${quoted(folderId)} in parents and ${clauses} and trashed = false`,
          fields: `nextPageToken,files(${fields})`,
          pageSize: PAGE_MAX,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        })
        const page = yield* getOk(url, fileList, folderId)
        files.push(...page.files)
        pageToken = page.nextPageToken
      } while (pageToken !== undefined)
      return files.sort(byAge)
    })

  const foldersNamed = (parentId: string, name: string) =>
    search(
      parentId,
      `name = ${quoted(name)} and mimeType = '${FOLDER_MIME}'`,
      'id,name,mimeType,createdTime',
    )

  /** Delete a folder this call made and lost, unless something was filed in it meanwhile. */
  const discard = (id: string) =>
    Effect.gen(function* () {
      const inside = driveUrl('/files', {
        q: `${quoted(id)} in parents and trashed = false`,
        fields: 'files(id,name,mimeType)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      if ((yield* getOk(inside, fileList, id)).files.length > 0) return
      const url = driveUrl(fileUrl(id), { supportsAllDrives: true })
      const response = yield* send('DELETE', url)
      if (response.status !== 204 && response.status !== 200)
        return yield* failure(response, id, url)
    }).pipe(Effect.catchTag('NotFound', () => Effect.void))

  /**
   * The child folder `name`, made when absent. Drive permits duplicate
   * names, so a racing call may make one too: after creating, every caller
   * re-reads and takes the oldest, and a loser deletes its own.
   */
  const ensureChild = (parentId: string, name: string) =>
    Effect.gen(function* () {
      const found = (yield* foldersNamed(parentId, name)).at(0)
      if (found !== undefined) return found.id
      const url = driveUrl('/files', {
        supportsAllDrives: true,
        fields: 'id,name,mimeType,createdTime',
      })
      const response = yield* send('POST', url, {
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      })
      if (response.status !== 200)
        return yield* failure(response, parentId, url)
      const made = yield* parse(driveFile, response.body, url)
      const seen = yield* foldersNamed(parentId, name)
      const oldest =
        [...seen.filter((f) => f.id !== made.id), made].sort(byAge).at(0) ??
        made
      if (oldest.id !== made.id) yield* discard(made.id)
      return oldest.id
    })

  const ensureFolder = Effect.fn('googleDrive.ensureFolder')(function* (
    rootId: string,
    path: string,
  ) {
    yield* folderOnly(rootId)
    let at = rootId
    for (const name of pathSegments(path)) at = yield* ensureChild(at, name)
    return at
  })

  /**
   * Stream `stream` into an open resumable session, one chunk held at a
   * time; the final answer is the file. A failed read cancels the stream.
   */
  const sendChunks = (
    session: string,
    stream: ReadableStream<Uint8Array>,
    id: string,
  ) =>
    Effect.suspend(() => {
      const reader = stream.getReader()
      return Effect.gen(function* () {
        const buffer = new Uint8Array(UPLOAD_CHUNK_BYTES)
        let held = 0
        let sent = 0
        const put = (range: string) =>
          send('PUT', session, buffer.slice(0, held), {
            'content-range': range,
          })
        for (;;) {
          const read = yield* Effect.promise(() => reader.read())
          if (read.done) break
          const chunk = read.value
          for (let at = 0; at < chunk.byteLength;) {
            const take = Math.min(
              UPLOAD_CHUNK_BYTES - held,
              chunk.byteLength - at,
            )
            buffer.set(chunk.subarray(at, at + take), held)
            held += take
            at += take
            if (held < UPLOAD_CHUNK_BYTES) continue
            const response = yield* put(`bytes ${sent}-${sent + held - 1}/*`)
            if (response.status !== 308)
              return yield* failure(response, id, session)
            sent += held
            held = 0
          }
        }
        const total = sent + held
        const last = yield* put(
          held === 0
            ? `bytes */${total}`
            : `bytes ${sent}-${total - 1}/${total}`,
        )
        if (last.status !== 200 && last.status !== 201)
          return yield* failure(last, id, session)
        return last
      }).pipe(
        Effect.onError(() =>
          Effect.ignore(Effect.tryPromise(() => reader.cancel())),
        ),
      )
    })

  /** One upload: a new file in a folder, or a new revision of a file. */
  const upload = (
    target: { readonly folderId: string } | { readonly fileId: string },
    name: string,
    content: StorageUpload,
  ) =>
    Effect.gen(function* () {
      const params = {
        uploadType: 'resumable',
        supportsAllDrives: true,
        fields: 'id,name,mimeType,headRevisionId,version',
      }
      const revision = 'fileId' in target
      const id = revision ? target.fileId : target.folderId
      const url = revision
        ? driveUrl(fileUrl(target.fileId), params, DRIVE_UPLOAD_API)
        : driveUrl('/files', params, DRIVE_UPLOAD_API)
      // The mime is the upload's own: never a native type, so never converted.
      const started = yield* send(
        revision ? 'PATCH' : 'POST',
        url,
        revision
          ? {}
          : { name, parents: [target.folderId], mimeType: content.mime },
        { 'x-upload-content-type': content.mime },
      )
      if (started.status !== 200) return yield* failure(started, id, url)
      const session = Object.hasOwn(started.headers, 'location')
        ? started.headers.location
        : ''
      // The session is where the bearer token goes next: Drive's host only.
      if (!session.startsWith(`${DRIVE_UPLOAD_API}/`))
        return yield* Effect.die(
          new Error(`Google Drive opened an upload at ${session || 'no URL'}`),
        )
      const done = yield* sendChunks(session, content.stream, id)
      const file = yield* parse(driveFile, done.body, session)
      const revisionId = file.headRevisionId ?? file.version
      if (revisionId === undefined)
        return yield* Effect.die(
          new Error(`Google Drive named no revision for ${file.id}`),
        )
      const result: PutFileResult = {
        fileId: file.id,
        revisionId,
        name,
        // The listing's token is `version`, so the change feed matches it.
        ...(file.version === undefined ? {} : { changeToken: file.version }),
      }
      return result
    })

  /** Past this many names taken, the folder is not one a person keeps. */
  const COLLISION_LIMIT = 1000

  const putFile = Effect.fn('googleDrive.putFile')(function* (
    folderId: string,
    name: string,
    content: StorageUpload,
  ) {
    if (content.mime.startsWith(NATIVE_PREFIX))
      return yield* Effect.die(
        new Error(`putFile uploads bytes; ${content.mime} would be converted`),
      )
    yield* folderOnly(folderId)
    const sha = content.sha256.toLowerCase()
    for (let n = 1; n <= COLLISION_LIMIT; n++) {
      const tried = collisionName(name, n)
      const taken = yield* search(
        folderId,
        `name = ${quoted(tried)} and mimeType != '${FOLDER_MIME}'`,
        'id,name,mimeType,createdTime,sha256Checksum',
      )
      // Same bytes: a revision of that file. Different: the next name.
      const same = taken.find((f) => f.sha256Checksum?.toLowerCase() === sha)
      if (same !== undefined)
        return yield* upload({ fileId: same.id }, tried, content)
      if (taken.length === 0) return yield* upload({ folderId }, tried, content)
    }
    return yield* Effect.die(
      new Error(`${folderId} holds ${COLLISION_LIMIT} files named ${name}`),
    )
  })

  const move = Effect.fn('googleDrive.move')(function* (
    id: string,
    folderId: string,
  ) {
    const meta = yield* metadata(id, 'id,name,mimeType,parents')
    yield* folderOnly(folderId)
    const parents = meta.parents ?? []
    const others = parents.filter((p) => p !== folderId)
    if (others.length === 0 && parents.length > 0) return
    const url = driveUrl(fileUrl(id), {
      addParents: parents.includes(folderId) ? undefined : folderId,
      removeParents: others.length === 0 ? undefined : others.join(','),
      supportsAllDrives: true,
      fields: 'id',
    })
    const response = yield* send('PATCH', url, {})
    if (response.status !== 200) return yield* failure(response, id, url)
  })

  const rename = Effect.fn('googleDrive.rename')(function* (
    id: string,
    name: string,
  ) {
    const meta = yield* metadata(id, 'id,name,mimeType')
    if (meta.name === name) return
    const url = driveUrl(fileUrl(id), { supportsAllDrives: true, fields: 'id' })
    const response = yield* send('PATCH', url, { name })
    if (response.status !== 200) return yield* failure(response, id, url)
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
