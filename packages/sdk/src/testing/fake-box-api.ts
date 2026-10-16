import type { JsonObject, JsonValue } from '../contract.ts'
import { fakeDriveLargeChunks } from './fake-drive.ts'
import type { FakeDriveLargeFile } from './fake-drive.ts'
import type { FetchLike } from './fake-drive-api.ts'
import type {
  StorageSourceChaos,
  StorageSourceChaosFixture,
  StorageSourceFixture,
} from './storage-source-conformance.ts'

/**
 * Box's REST API, in process: a `fetch`-shaped function answering what a
 * storage-source plugin and the connect dance call — content API, events,
 * downloads and OAuth — over a seeded, mutable tree. No network, no clock.
 *
 * - Box's shapes, not Drive's: numeric ids under the root `0` ("All
 *   Files"), `path_collection` ancestry, marker paging, no mime type on a
 *   file (only its name), and a `sha1` the plugin must never surface.
 * - `fields` is honoured: without it a listing entry is Box's mini object,
 *   so a plugin that forgets to ask for `size` or `modified_at` gets none.
 * - A download answers 302 to `dl.boxcloud.com`, as Box's does.
 * - A Box Note's `/content` is its JSON; its text is the `extracted_text`
 *   representation, deterministic, so it hashes the same every time.
 * - The events stream has no delta per folder: `next_stream_position` is a
 *   64-bit integer written unquoted, beyond `Number`'s precision; a
 *   position older than the retained window (`evictCursors`) is a 400.
 * - OAuth: a refresh token is single-use — spent, it is `invalid_grant` —
 *   and `lapse()` expires every live one, Box's 60 days of inactivity.
 */

export const BOX_API = 'https://api.box.com/2.0'
export const BOX_OAUTH = 'https://api.box.com/oauth2'
export const BOX_AUTHORIZE_URL = 'https://account.box.com/api/oauth2/authorize'
export const BOX_DOWNLOAD = 'https://dl.boxcloud.com'

/** Every Box account's root folder. */
export const BOX_ROOT_ID = '0'

/** Where event positions start: Box's are 64-bit and past 2^53. */
const POSITION_BASE = 1152922976252290017n

/** One item of a seed tree; the root `0` is always there. */
export type FakeBoxSeedItem =
  | {
      readonly kind: 'folder'
      readonly id: string
      readonly name: string
      readonly parentId: string
      /** `https://app.box.com/s/<sharedName>` opens it. */
      readonly sharedName?: string
    }
  | {
      readonly kind: 'file'
      readonly id: string
      readonly name: string
      readonly parentId: string
      readonly content: string
      readonly sharedName?: string
    }
  | {
      /** A Box Note: `<name>.boxnote`, its body a doc of paragraphs. */
      readonly kind: 'note'
      readonly id: string
      readonly name: string
      readonly parentId: string
      readonly paragraphs: ReadonlyArray<string>
      readonly sharedName?: string
    }
  | {
      /** A bookmark: listed by Box, no bytes. */
      readonly kind: 'web_link'
      readonly id: string
      readonly name: string
      readonly parentId: string
      readonly url: string
    }

/**
 * The data room, as Box holds it. `1001` has five file and folder children
 * plus a web link; `1004` is three deep; `2001` is a Box Note.
 */
export const FAKE_BOX_SEED: ReadonlyArray<FakeBoxSeedItem> = [
  {
    kind: 'folder',
    id: '1001',
    name: 'Acme Data Room',
    parentId: BOX_ROOT_ID,
    sharedName: 'acmedataroom',
  },
  { kind: 'folder', id: '1002', name: '01 Legal', parentId: '1001' },
  { kind: 'folder', id: '1003', name: '02 Finance', parentId: '1001' },
  { kind: 'folder', id: '1004', name: 'Board', parentId: '1003' },
  { kind: 'folder', id: '1005', name: 'Portfolio', parentId: BOX_ROOT_ID },
  { kind: 'folder', id: '1006', name: 'Acme', parentId: '1005' },
  {
    kind: 'note',
    id: '2001',
    name: 'Investment memo.boxnote',
    parentId: '1001',
    paragraphs: [
      'Acme investment memo',
      'Thesis: the data room tool every fund already wants.',
      'Risks: a crowded market and a two-person team.',
      'Terms: $2m seed at $10m post.',
    ],
  },
  {
    kind: 'file',
    id: '2002',
    name: 'Acme deck.pdf',
    parentId: '1001',
    content: '%PDF-1.7 Acme seed deck',
    sharedName: 'acmedeck',
  },
  {
    kind: 'file',
    id: '2003',
    name: 'Cap table.xlsx',
    parentId: '1001',
    content: 'PK cap table',
  },
  {
    kind: 'web_link',
    id: '3001',
    name: 'Acme website',
    parentId: '1001',
    url: 'https://acme.example',
  },
  {
    kind: 'file',
    id: '2004',
    name: 'Share purchase agreement.pdf',
    parentId: '1002',
    content: '%PDF-1.7 SPA',
  },
  {
    kind: 'file',
    id: '2005',
    name: 'Term sheet.pdf',
    parentId: '1002',
    content: '%PDF-1.7 Acme term sheet',
  },
  {
    kind: 'file',
    id: '2006',
    name: 'Financial model.xlsx',
    parentId: '1003',
    content: 'PK financial model',
  },
  {
    kind: 'file',
    id: '2007',
    name: 'Minutes Q3.pdf',
    parentId: '1004',
    content: '%PDF-1.7 Q3 minutes',
  },
  {
    kind: 'file',
    id: '2008',
    name: 'Q3 update.pdf',
    parentId: '1006',
    content: '%PDF-1.7 Q3 investor update',
  },
]

/** What the conformance suite expects of `FAKE_BOX_SEED`, written apart from it. */
export const FAKE_BOX_FIXTURE: StorageSourceFixture = {
  dataRoom: {
    folderId: '1001',
    link: 'https://app.box.com/folder/1001',
    childIds: ['1002', '1003', '2001', '2002', '2003'],
  },
  nativeDoc: {
    fileId: '2001',
    folderId: '1001',
    link: 'https://app.box.com/notes/2001',
    exportMime: 'text/plain',
  },
  ancestry: [
    { folderId: '1004', ancestorIds: [BOX_ROOT_ID, '1001', '1003'] },
    { folderId: '1006', ancestorIds: [BOX_ROOT_ID, '1005'] },
    { folderId: BOX_ROOT_ID, ancestorIds: [] },
  ],
  foreignLink: 'https://drive.google.com/drive/folders/dataroom',
  missingId: '9999999',
}

/** A 200 MB scan in `01 Legal`: the same generated bytes as the fake Drive's, so the same SHA-256. */
export const FAKE_BOX_SCAN: FakeDriveLargeFile = {
  id: '2099',
  name: 'Diligence scan.pdf',
  parentId: '1002',
  mime: 'application/pdf',
  size: 200 * 1024 * 1024,
  chunkSize: 16 * 1024,
}

export const FAKE_BOX_CHAOS_FIXTURE: StorageSourceChaosFixture = {
  ...FAKE_BOX_FIXTURE,
  vanishingFileId: '2002',
  largeFile: {
    fileId: FAKE_BOX_SCAN.id,
    size: FAKE_BOX_SCAN.size,
    sha256: '072c574d74e1e9a0a838f152c6f5644c9be16b89a6fb609d36da2c2f3f03af8b',
  },
}

/** The OAuth client and the connection the fake starts with. The secret and refresh token must never leave it. */
export type FakeBoxCredentials = {
  readonly clientId: string
  readonly clientSecret: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly userId: string
  readonly login: string
}

export const FAKE_BOX_CREDENTIALS: FakeBoxCredentials = {
  clientId: 'fake-box-client-id',
  clientSecret: 'fake-box-client-secret-do-not-ship',
  accessToken: 'fake-box-access-token',
  refreshToken: 'fake-box-refresh-token-do-not-ship',
  userId: '11446498',
  login: 'partner@fund.example',
}

/** One request the fake received; `path` is relative to its endpoint's base. */
export type BoxApiRequest = {
  readonly method: string
  readonly url: string
  readonly endpoint: 'api' | 'oauth' | 'authorize' | 'download'
  readonly path: string
  readonly query: { readonly [name: string]: string | undefined }
}

/** The OAuth half: what the token endpoint has issued and spent. */
export type FakeBoxOAuth = {
  /** Refresh tokens still good, oldest first. */
  readonly liveRefreshTokens: () => ReadonlyArray<string>
  /** Every form the token endpoint received, in order. */
  readonly tokenRequests: ReadonlyArray<URLSearchParams>
  /** Every refresh token now fails `invalid_grant`: 60 days without use. */
  readonly lapse: () => void
}

export type FakeBoxApi = {
  readonly fetch: FetchLike
  readonly requests: ReadonlyArray<BoxApiRequest>
  /** The bearer token the fake accepts from the start. */
  readonly accessToken: string
  readonly chaos: StorageSourceChaos
  readonly oauth: FakeBoxOAuth
  /** Add an item under a live folder: an `ITEM_CREATE` or `ITEM_UPLOAD` event. */
  readonly add: (item: FakeBoxSeedItem) => void
  /** Move an item to the trash: one `ITEM_TRASH` event, its subtree gone with it. */
  readonly trash: (id: string) => void
  readonly rename: (id: string, name: string) => void
  readonly move: (id: string, parentId: string) => void
  /** New content (a note takes paragraphs): a new file version, an `ITEM_UPLOAD` event. */
  readonly edit: (id: string, content: string | ReadonlyArray<string>) => void
  /** The note's text representation answers `pending` for the next `polls` reads of its status. */
  readonly pendingText: (id: string, polls: number) => void
}

export type FakeBoxApiOptions = {
  readonly seed?: ReadonlyArray<FakeBoxSeedItem>
  /** Generated on read and streamed through, never held. */
  readonly largeFiles?: ReadonlyArray<FakeDriveLargeFile>
  readonly credentials?: FakeBoxCredentials
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

type Body =
  | { readonly _tag: 'bytes'; readonly bytes: Uint8Array }
  | { readonly _tag: 'lazy'; readonly file: FakeDriveLargeFile }
  | { readonly _tag: 'note'; readonly paragraphs: ReadonlyArray<string> }
  | { readonly _tag: 'none' }

type Item = {
  readonly id: string
  readonly type: 'folder' | 'file' | 'web_link'
  name: string
  parentId: string | null
  body: Body
  readonly url: string | null
  readonly sharedName: string | null
  /** Bumped on every change, as Box's `etag` and `sequence_id` are. */
  etag: number
  /** A file's content version: a new one on every upload. */
  version: number
  readonly createdAt: string
  modifiedAt: string
  trashed: boolean
}

type Event = {
  readonly eventId: string
  readonly eventType: string
  readonly createdAt: string
  /** The item as it was when the event happened. */
  readonly source: JsonObject
}

/** Box's `changes` stream: events that change the tree. */
const CHANGE_EVENTS = new Set([
  'ITEM_CREATE',
  'ITEM_UPLOAD',
  'ITEM_MOVE',
  'ITEM_COPY',
  'ITEM_RENAME',
  'ITEM_TRASH',
  'ITEM_UNDELETE_VIA_TRASH',
])

const encoder = new TextEncoder()
const BASE_MS = Date.UTC(2026, 0, 1)

/** Box writes times in the account's zone, here Pacific: `2026-01-01T00:00:01-08:00`. */
const pacific = (ms: number) =>
  `${new Date(ms - 8 * 3_600_000).toISOString().slice(0, 19)}-08:00`

/** A stand-in for Box's `sha1`: stable per content, and not our SHA-256. */
const fakeSha1 = (text: string): string => {
  let h = 0x811c9dc5
  for (const b of encoder.encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0').repeat(5)
}

/** A note's file body: Box Notes' ProseMirror document. */
const noteJson = (paragraphs: ReadonlyArray<string>) =>
  JSON.stringify({
    doc: {
      type: 'doc',
      content: paragraphs.map((text) => ({
        type: 'paragraph',
        content: [{ type: 'text', text }],
      })),
    },
    schema_version: 1,
  })

/** What Box extracts from a note: its paragraphs, one per line. */
const noteText = (paragraphs: ReadonlyArray<string>) => paragraphs.join('\n')

/** Two chunks for held bytes, so a reader that keeps only the first is caught. */
const streamOfBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
  const copy = bytes.slice()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const half = Math.ceil(copy.byteLength / 2)
      controller.enqueue(copy.subarray(0, half))
      if (half < copy.byteLength) controller.enqueue(copy.subarray(half))
      controller.close()
    },
  })
}

/** Pull-based: a chunk of a large file is made only when the reader asks. */
const streamOfLarge = (
  file: FakeDriveLargeFile,
): ReadableStream<Uint8Array> => {
  const chunks = fakeDriveLargeChunks(file)
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    cancel() {
      chunks.return()
    },
  })
}

const sizeOf = (body: Body): number => {
  switch (body._tag) {
    case 'bytes':
      return body.bytes.byteLength
    case 'lazy':
      return body.file.size
    case 'note':
      return encoder.encode(noteJson(body.paragraphs)).byteLength
    case 'none':
      return 0
  }
}

const json = (
  status: number,
  body: JsonValue,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/** Box's error envelope. */
const boxError = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response =>
  json(
    status,
    {
      type: 'error',
      status,
      code,
      message,
      help_url: 'http://developers.box.com/docs/#errors',
      request_id: 'fake-request',
    },
    headers,
  )

/** Box's 401: an empty body and the reason in `WWW-Authenticate`. */
const unauthorized = () =>
  new Response(null, {
    status: 401,
    headers: {
      'www-authenticate':
        'Bearer realm="Service", error="invalid_token", error_description="The access token provided is invalid."',
    },
  })

const oauthError = (error: string, description: string) =>
  json(400, { error, error_description: description })

const formOf = (body: string | Uint8Array | undefined) =>
  new URLSearchParams(
    body === undefined
      ? ''
      : typeof body === 'string'
        ? body
        : new TextDecoder().decode(body),
  )

type Query = { readonly [name: string]: string | undefined }

export const makeFakeBoxApi = (options: FakeBoxApiOptions = {}): FakeBoxApi => {
  const credentials = options.credentials ?? FAKE_BOX_CREDENTIALS
  const items = new Map<string, Item>()
  const log: Array<Event> = []
  const requests: Array<BoxApiRequest> = []
  let clock = 0
  let floor = 0
  let limited = 0
  let retryAfterSeconds = 1
  let revoked = false
  const vanishing = new Set<string>()
  const pending = new Map<string, number>()
  const downloads = new Map<string, string>()

  const tick = () => pacific(BASE_MS + ++clock * 1000)

  const put = (
    fields: Pick<Item, 'id' | 'type' | 'name' | 'parentId' | 'body'> & {
      readonly url?: string
      readonly sharedName?: string
    },
  ): Item => {
    if (items.has(fields.id)) throw new Error(`fake box: ${fields.id} exists`)
    const parent =
      fields.parentId === null ? undefined : items.get(fields.parentId)
    if (fields.parentId !== null && parent?.type !== 'folder')
      throw new Error(`fake box: ${fields.id}'s parent is not a folder`)
    const now = tick()
    const item: Item = {
      id: fields.id,
      type: fields.type,
      name: fields.name,
      parentId: fields.parentId,
      body: fields.body,
      url: fields.url ?? null,
      sharedName: fields.sharedName ?? null,
      etag: 0,
      version: 1,
      createdAt: now,
      modifiedAt: now,
      trashed: false,
    }
    items.set(item.id, item)
    return item
  }

  put({
    id: BOX_ROOT_ID,
    type: 'folder',
    name: 'All Files',
    parentId: null,
    body: { _tag: 'none' },
  })

  const insert = (seed: FakeBoxSeedItem): Item => {
    const shared =
      seed.kind !== 'web_link' && seed.sharedName !== undefined
        ? { sharedName: seed.sharedName }
        : {}
    switch (seed.kind) {
      case 'folder':
        return put({
          id: seed.id,
          type: 'folder',
          name: seed.name,
          parentId: seed.parentId,
          body: { _tag: 'none' },
          ...shared,
        })
      case 'file':
        return put({
          id: seed.id,
          type: 'file',
          name: seed.name,
          parentId: seed.parentId,
          body: { _tag: 'bytes', bytes: encoder.encode(seed.content) },
          ...shared,
        })
      case 'note':
        return put({
          id: seed.id,
          type: 'file',
          name: seed.name,
          parentId: seed.parentId,
          body: { _tag: 'note', paragraphs: [...seed.paragraphs] },
          ...shared,
        })
      case 'web_link':
        return put({
          id: seed.id,
          type: 'web_link',
          name: seed.name,
          parentId: seed.parentId,
          body: { _tag: 'none' },
          url: seed.url,
        })
    }
  }

  for (const seed of options.seed ?? FAKE_BOX_SEED) insert(seed)
  for (const file of options.largeFiles ?? [])
    put({
      id: file.id,
      type: 'file',
      name: file.name,
      parentId: file.parentId,
      body: { _tag: 'lazy', file },
    })

  const mustGet = (id: string): Item => {
    const item = items.get(id)
    if (item === undefined) throw new Error(`fake box: no item ${id}`)
    return item
  }

  /** Not in the trash, and no ancestor is. */
  const live = (item: Item): boolean => {
    for (let at: Item | undefined = item; at !== undefined;) {
      if (at.trashed) return false
      at = at.parentId === null ? undefined : items.get(at.parentId)
    }
    return true
  }

  const ancestors = (item: Item): Array<Item> => {
    const chain: Array<Item> = []
    for (let up = item.parentId; up !== null;) {
      const parent = mustGet(up)
      chain.unshift(parent)
      up = parent.parentId
    }
    return chain
  }

  const TYPE_ORDER = { folder: 0, file: 1, web_link: 2 }

  const children = (folderId: string): Array<Item> =>
    [...items.values()]
      .filter((i) => i.parentId === folderId && !i.trashed)
      .sort(
        (a, b) =>
          TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      )

  // -------------------------------------------------------------------------
  // JSON, as Box writes it
  // -------------------------------------------------------------------------

  const etagOf = (item: Item) =>
    item.id === BOX_ROOT_ID ? null : String(item.etag)

  const mini = (item: Item): JsonObject => ({
    type: item.type,
    id: item.id,
    sequence_id: etagOf(item),
    etag: etagOf(item),
    name: item.name,
  })

  const sha1Of = (item: Item) =>
    item.body._tag === 'lazy'
      ? fakeSha1(`${item.id}:${item.body.file.size}`)
      : fakeSha1(`${item.id}:${item.version}:${sizeOf(item.body)}`)

  const versionIdOf = (item: Item) =>
    `${item.id}${String(item.version).padStart(3, '0')}`

  const fileVersionOf = (item: Item): JsonObject => ({
    type: 'file_version',
    id: versionIdOf(item),
    sha1: sha1Of(item),
  })

  const extensionOf = (name: string) => {
    const dot = name.lastIndexOf('.')
    return dot <= 0 ? '' : name.slice(dot + 1)
  }

  const isNote = (item: Item) => item.body._tag === 'note'

  /** The full object, as `GET /files/:id` or an event's `source` has it. */
  const full = (item: Item): JsonObject => {
    const parent = item.parentId === null ? null : mustGet(item.parentId)
    const path = ancestors(item)
    const base: JsonObject = {
      ...mini(item),
      description: '',
      size: item.type === 'web_link' ? null : sizeOf(item.body),
      path_collection: {
        total_count: path.length,
        entries: path.map(mini),
      },
      created_at: item.createdAt,
      modified_at: item.modifiedAt,
      trashed_at: item.trashed ? item.modifiedAt : null,
      purged_at: null,
      parent: parent === null ? null : mini(parent),
      item_status: item.trashed ? 'trashed' : 'active',
      shared_link:
        item.sharedName === null
          ? null
          : {
              url: `https://app.box.com/s/${item.sharedName}`,
              access: 'open',
            },
    }
    if (item.type === 'web_link') return { ...base, url: item.url }
    if (item.type === 'folder') return base
    return {
      ...base,
      sha1: sha1Of(item),
      file_version: fileVersionOf(item),
      content_created_at: item.createdAt,
      content_modified_at: item.modifiedAt,
    }
  }

  /** Box's `fields`: what was asked for, plus `type` and `id`. */
  const withFields = (
    item: Item,
    fields: string | undefined,
    whole: JsonObject,
    query: { readonly repHints: string | undefined },
  ): JsonObject => {
    if (fields === undefined) return whole
    const out: { [key: string]: JsonValue } = { type: item.type, id: item.id }
    for (const raw of fields.split(',')) {
      const field = raw.trim()
      if (field === 'extension' && item.type === 'file')
        out.extension = extensionOf(item.name)
      else if (field === 'representations' && item.type === 'file')
        out.representations = representations(item, query.repHints)
      else if (Object.hasOwn(whole, field)) out[field] = whole[field]
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  const record = (eventType: string, item: Item) => {
    log.push({
      eventId: `fake-event-${log.length + 1}`,
      eventType,
      createdAt: item.modifiedAt,
      source: full(item),
    })
  }

  const touch = (item: Item) => {
    item.etag += 1
    item.modifiedAt = tick()
  }

  const trashItem = (item: Item) => {
    item.trashed = true
    touch(item)
    record('ITEM_TRASH', item)
  }

  const positionOf = (index: number) =>
    (POSITION_BASE + BigInt(index)).toString()

  /** A position's index into the log, or null when Box no longer holds it. */
  const indexOf = (position: string): number | null => {
    if (!/^\d+$/.test(position)) return null
    const index = BigInt(position) - POSITION_BASE
    if (index < BigInt(floor) || index > BigInt(log.length)) return null
    return Number(index)
  }

  /** The events body, with `next_stream_position` unquoted as Box writes it. */
  const eventsBody = (entries: ReadonlyArray<JsonObject>, next: string) =>
    new Response(
      JSON.stringify({
        chunk_size: entries.length,
        next_stream_position: '__NEXT__',
        entries,
      }).replace('"__NEXT__"', next),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  const eventJson = (event: Event): JsonObject => ({
    type: 'event',
    event_id: event.eventId,
    event_type: event.eventType,
    created_at: event.createdAt,
    recorded_at: event.createdAt,
    session_id: null,
    created_by: {
      type: 'user',
      id: credentials.userId,
      login: credentials.login,
    },
    source: event.source,
  })

  const events = (query: Query) => {
    const position = query.stream_position ?? positionOf(floor)
    if (position === 'now') return eventsBody([], positionOf(log.length))
    const from = indexOf(position)
    if (from === null)
      return boxError(
        400,
        'invalid_parameter',
        `Invalid value for stream_position: ${position}`,
      )
    const limit = Math.min(
      500,
      Math.max(1, Number(query.limit ?? '100') || 100),
    )
    const changesOnly = query.stream_type === 'changes'
    const entries: Array<JsonObject> = []
    let at = from
    for (; at < log.length && entries.length < limit; at++) {
      const event = log[at]
      if (!changesOnly || CHANGE_EVENTS.has(event.eventType))
        entries.push(eventJson(event))
    }
    return eventsBody(entries, positionOf(at))
  }

  // -------------------------------------------------------------------------
  // The content API
  // -------------------------------------------------------------------------

  const notFound = (id: string, item: Item | undefined) =>
    item?.trashed === true
      ? boxError(404, 'trashed', `Item ${id} is trashed`)
      : boxError(404, 'not_found', 'Not Found')

  /** The item at `id` when it is live and of `type`. */
  const reach = (id: string, type: Item['type']) => {
    const item = items.get(id)
    return item !== undefined && item.type === type && live(item) ? item : null
  }

  const textUrls = (item: Item) => {
    const at = `/internal_files/${item.id}/versions/${versionIdOf(item)}/representations/extracted_text`
    return {
      info: `${BOX_API}${at}`,
      content: `${BOX_DOWNLOAD}/api/2.0${at}/content/{+asset_path}`,
    }
  }

  const textState = (item: Item) =>
    (pending.get(item.id) ?? 0) > 0 ? 'pending' : 'success'

  const representationJson = (item: Item): JsonObject => {
    const urls = textUrls(item)
    return {
      representation: 'extracted_text',
      properties: {},
      info: { url: urls.info },
      status: { state: textState(item) },
      content: { url_template: urls.content },
    }
  }

  /** Only what `x-rep-hints` asks for; a note alone has a text representation here. */
  const representations = (
    item: Item,
    hints: string | undefined,
  ): JsonObject => ({
    entries:
      isNote(item) && (hints ?? '').includes('[extracted_text]')
        ? [representationJson(item)]
        : [],
  })

  const getFolder = (id: string, query: Query) => {
    const item = reach(id, 'folder')
    if (item === null) return notFound(id, items.get(id))
    return json(
      200,
      withFields(item, query.fields, full(item), { repHints: undefined }),
    )
  }

  const getFile = (id: string, query: Query, repHints: string | undefined) => {
    const item = reach(id, 'file')
    if (item === null) return notFound(id, items.get(id))
    return json(200, withFields(item, query.fields, full(item), { repHints }))
  }

  const getWebLink = (id: string, query: Query) => {
    const item = reach(id, 'web_link')
    if (item === null) return notFound(id, items.get(id))
    return json(
      200,
      withFields(item, query.fields, full(item), { repHints: undefined }),
    )
  }

  const MARKER = /^m:([^:]+):(\d+)$/

  const decodeMarker = (marker: string) => {
    try {
      return atob(marker)
    } catch {
      return ''
    }
  }

  const folderItems = (id: string, query: Query) => {
    const folder = reach(id, 'folder')
    if (folder === null) return notFound(id, items.get(id))
    const limit = Math.min(
      1000,
      Math.max(1, Number(query.limit ?? '100') || 100),
    )
    const all = children(id)
    let offset = 0
    const marker = query.usemarker === 'true'
    if (marker && query.marker !== undefined) {
      const decoded = MARKER.exec(decodeMarker(query.marker))
      if (decoded?.[1] !== id)
        return boxError(400, 'invalid_parameter', 'Invalid marker')
      offset = Number(decoded[2])
    } else if (!marker && query.offset !== undefined) {
      offset = Number(query.offset)
      if (!Number.isInteger(offset) || offset < 0)
        return boxError(400, 'invalid_parameter', 'Invalid offset')
    }
    const page = all.slice(offset, offset + limit)
    const end = offset + page.length
    // Without `fields`, a listing entry is Box's mini object.
    const entries = page.map((item) =>
      query.fields === undefined
        ? item.type === 'file'
          ? {
              ...mini(item),
              file_version: fileVersionOf(item),
              sha1: sha1Of(item),
            }
          : mini(item)
        : withFields(item, query.fields, full(item), { repHints: undefined }),
    )
    for (const item of page) if (vanishing.delete(item.id)) trashItem(item)
    const order = [
      { by: 'type', direction: 'ASC' },
      { by: 'name', direction: 'ASC' },
    ]
    if (marker)
      return json(200, {
        entries,
        limit,
        next_marker: end < all.length ? btoa(`m:${id}:${end}`) : null,
        prev_marker: null,
        order,
      })
    return json(200, {
      entries,
      limit,
      offset,
      total_count: all.length,
      order,
    })
  }

  /** `/files/:id/content`: a 302 to a one-off download URL; a note's body is its JSON. */
  const fileContent = (id: string) => {
    const item = reach(id, 'file')
    if (item === null) return notFound(id, items.get(id))
    const token = `t${downloads.size + 1}`
    downloads.set(token, id)
    return new Response(null, {
      status: 302,
      headers: { location: `${BOX_DOWNLOAD}/d/1/${token}/download` },
    })
  }

  const download = (token: string) => {
    const id = downloads.get(token)
    const item = id === undefined ? null : reach(id, 'file')
    if (item === null) return boxError(404, 'not_found', 'Not Found')
    const { body } = item
    const stream =
      body._tag === 'lazy'
        ? streamOfLarge(body.file)
        : streamOfBytes(
            body._tag === 'bytes'
              ? body.bytes
              : encoder.encode(
                  body._tag === 'note' ? noteJson(body.paragraphs) : '',
                ),
          )
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })
  }

  const REP =
    /^\/internal_files\/(\d+)\/versions\/(\d+)\/representations\/extracted_text$/

  /** The info URL: reading it moves a pending representation along. */
  const representationInfo = (id: string, versionId: string) => {
    const item = reach(id, 'file')
    if (item === null || !isNote(item) || versionIdOf(item) !== versionId)
      return boxError(404, 'not_found', 'Not Found')
    const left = pending.get(id) ?? 0
    if (left > 0) pending.set(id, left - 1)
    return json(200, representationJson(item))
  }

  const representationContent = (id: string, versionId: string) => {
    const item = reach(id, 'file')
    if (
      item === null ||
      item.body._tag !== 'note' ||
      versionIdOf(item) !== versionId
    )
      return boxError(404, 'not_found', 'Not Found')
    if (textState(item) !== 'success')
      return new Response(null, {
        status: 202,
        headers: { 'retry-after': '5' },
      })
    return new Response(
      streamOfBytes(encoder.encode(noteText(item.body.paragraphs))),
      {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    )
  }

  const sharedItem = (header: string | undefined) => {
    const link = /^shared_link=(.+?)(?:&shared_link_password=.*)?$/.exec(
      header ?? '',
    )?.[1]
    if (link === undefined)
      return boxError(400, 'bad_request', 'Missing BoxApi shared_link')
    const name = /^https:\/\/[\w.-]*box\.com\/s\/([\w-]+)\/?$/.exec(
      decodeURIComponent(link),
    )?.[1]
    const item = [...items.values()].find(
      (i) => i.sharedName !== null && i.sharedName === name && live(i),
    )
    if (item === undefined) return boxError(404, 'not_found', 'Not Found')
    return json(200, full(item))
  }

  const usersMe = (query: Query) => {
    const whole: JsonObject = {
      type: 'user',
      id: credentials.userId,
      name: 'Fake Box user',
      login: credentials.login,
    }
    if (query.fields === undefined) return json(200, whole)
    const out: { [key: string]: JsonValue } = {
      type: 'user',
      id: credentials.userId,
    }
    for (const field of query.fields.split(','))
      if (Object.hasOwn(whole, field.trim()))
        out[field.trim()] = whole[field.trim()]
    return json(200, out)
  }

  const routeApi = (
    method: string,
    path: string,
    query: Query,
    headers: Record<string, string>,
  ): Response => {
    if (method !== 'GET')
      return boxError(405, 'method_not_allowed', `${method} ${path}`)
    const id = (pattern: RegExp) => pattern.exec(path)?.[1]
    const folderItemsOf = id(/^\/folders\/(\d+)\/items$/)
    if (folderItemsOf !== undefined) return folderItems(folderItemsOf, query)
    const folderOf = id(/^\/folders\/(\d+)$/)
    if (folderOf !== undefined) return getFolder(folderOf, query)
    const contentOf = id(/^\/files\/(\d+)\/content$/)
    if (contentOf !== undefined) return fileContent(contentOf)
    const fileOf = id(/^\/files\/(\d+)$/)
    if (fileOf !== undefined)
      return getFile(fileOf, query, headers['x-rep-hints'])
    const linkOf = id(/^\/web_links\/(\d+)$/)
    if (linkOf !== undefined) return getWebLink(linkOf, query)
    const rep = REP.exec(path)
    if (rep !== null) return representationInfo(rep[1], rep[2])
    if (path === '/events') return events(query)
    if (path === '/shared_items') return sharedItem(headers.boxapi)
    if (path === '/users/me') return usersMe(query)
    // A path with something other than digits for an id is no item at all.
    return boxError(404, 'not_found', `The fake Box API has no ${path}`)
  }

  const routeDownload = (path: string): Response => {
    const token = /^\/d\/1\/([\w-]+)\/download$/.exec(path)?.[1]
    if (token !== undefined) return download(token)
    const rep =
      /^\/api\/2\.0\/internal_files\/(\d+)\/versions\/(\d+)\/representations\/extracted_text\/content\/?$/.exec(
        path,
      )
    if (rep !== null) return representationContent(rep[1], rep[2])
    return boxError(404, 'not_found', 'Not Found')
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  const accessTokens = new Set([credentials.accessToken])
  /** Live refresh token → the access token issued beside it. */
  const refreshTokens = new Map([
    [credentials.refreshToken, credentials.accessToken],
  ])
  const codes = new Set<string>()
  const tokenRequests: Array<URLSearchParams> = []
  let issued = 0
  let minted = 0
  let lapsed = false

  const issue = () => {
    issued += 1
    const accessToken = `fake-box-access-${issued}`
    const refreshToken = `fake-box-refresh-${issued}`
    accessTokens.add(accessToken)
    refreshTokens.set(refreshToken, accessToken)
    // Box's answer: no `scope`, and no lapse for the refresh token.
    return json(200, {
      access_token: accessToken,
      expires_in: 3600,
      restricted_to: [],
      refresh_token: refreshToken,
      token_type: 'bearer',
    })
  }

  const authorize = (query: Query) => {
    const redirect = query.redirect_uri
    if (
      query.response_type !== 'code' ||
      query.client_id !== credentials.clientId ||
      redirect === undefined ||
      !URL.canParse(redirect)
    )
      return new Response('Invalid authorization request', { status: 400 })
    minted += 1
    const code = `fake-box-code-${minted}`
    codes.add(code)
    const back = new URL(redirect)
    back.searchParams.set('code', code)
    if (query.state !== undefined) back.searchParams.set('state', query.state)
    return new Response(null, {
      status: 302,
      headers: { location: back.toString() },
    })
  }

  const token = (form: URLSearchParams) => {
    tokenRequests.push(form)
    if (
      form.get('client_id') !== credentials.clientId ||
      form.get('client_secret') !== credentials.clientSecret
    )
      return oauthError('invalid_client', 'The client credentials are invalid')
    switch (form.get('grant_type')) {
      case 'authorization_code': {
        const code = form.get('code') ?? ''
        if (!codes.delete(code))
          return oauthError(
            'invalid_grant',
            'Auth code doesn’t exist or is invalid for the client',
          )
        return issue()
      }
      case 'refresh_token': {
        const spent = form.get('refresh_token') ?? ''
        if (lapsed && refreshTokens.has(spent))
          return oauthError('invalid_grant', 'Refresh token has expired')
        // Single-use: the token is gone the moment it is traded.
        if (!refreshTokens.delete(spent))
          return oauthError('invalid_grant', 'Invalid refresh token')
        return issue()
      }
      default:
        return oauthError(
          'unsupported_grant_type',
          'Invalid grant_type parameter or parameter missing',
        )
    }
  }

  /** Revoking either token of a pair ends both. */
  const revokeToken = (form: URLSearchParams) => {
    const value = form.get('token') ?? ''
    const pairedAccess = refreshTokens.get(value)
    if (pairedAccess !== undefined) {
      refreshTokens.delete(value)
      accessTokens.delete(pairedAccess)
    }
    for (const [refresh, access] of refreshTokens)
      if (access === value) refreshTokens.delete(refresh)
    accessTokens.delete(value)
    return new Response(null, { status: 200 })
  }

  // -------------------------------------------------------------------------
  // fetch
  // -------------------------------------------------------------------------

  const ENDPOINTS: ReadonlyArray<readonly [BoxApiRequest['endpoint'], string]> =
    [
      ['oauth', BOX_OAUTH],
      ['authorize', BOX_AUTHORIZE_URL],
      ['api', BOX_API],
      ['download', BOX_DOWNLOAD],
    ]

  /**
   * The gate every content request passes: revoked, then rate limited.
   * `bearer` null is a pre-signed download URL, which carries no token.
   */
  const gate = (bearer: string | undefined | null): Response | null => {
    const known =
      bearer === null ||
      (bearer !== undefined &&
        bearer.startsWith('Bearer ') &&
        accessTokens.has(bearer.slice('Bearer '.length)))
    if (revoked || !known) return unauthorized()
    if (limited > 0) {
      limited -= 1
      return boxError(
        429,
        'rate_limit_exceeded',
        'Request rate limit exceeded, please try again later',
        {
          'retry-after': String(retryAfterSeconds),
        },
      )
    }
    return null
  }

  const fetch: FetchLike = (url, init) => {
    const parsed = new URL(url)
    const query: { [name: string]: string } = {}
    parsed.searchParams.forEach((value, name) => {
      query[name] = value
    })
    const at = `${parsed.origin}${parsed.pathname}`
    const found = ENDPOINTS.find(
      ([, base]) => at === base || at.startsWith(`${base}/`),
    )
    const path =
      found === undefined ? parsed.pathname : at.slice(found[1].length)
    const endpoint = found?.[0] ?? 'api'
    requests.push({ method: init.method, url, endpoint, path, query })
    if (found === undefined)
      return Promise.resolve(boxError(404, 'not_found', `${url} is not Box`))
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(init.headers))
      headers[name.toLowerCase()] = value
    const answer = (): Response => {
      switch (endpoint) {
        case 'authorize':
          return init.method === 'GET'
            ? authorize(query)
            : new Response(null, { status: 405 })
        case 'oauth':
          if (init.method !== 'POST') return new Response(null, { status: 405 })
          if (path === '/token') return token(formOf(init.body))
          if (path === '/revoke') return revokeToken(formOf(init.body))
          return new Response(null, { status: 404 })
        case 'download': {
          // A file download URL is pre-signed; a representation's wants the token.
          const refused = gate(
            path.startsWith('/d/') ? null : headers.authorization,
          )
          return refused ?? routeDownload(path)
        }
        case 'api':
          return (
            gate(headers.authorization) ??
            routeApi(init.method, path, query, headers)
          )
      }
    }
    return Promise.resolve(answer())
  }

  // -------------------------------------------------------------------------
  // Mutators and toggles
  // -------------------------------------------------------------------------

  const chaos: StorageSourceChaos = {
    rateLimit: (calls, retryAfterMs) => {
      limited = calls
      retryAfterSeconds = Math.ceil(retryAfterMs / 1000)
    },
    // Box keeps a window of events: everything before now drops out of it.
    evictCursors: () => {
      record('ITEM_PREVIEW', mustGet(BOX_ROOT_ID))
      floor = log.length
    },
    vanish: (id) => {
      mustGet(id)
      vanishing.add(id)
    },
    revoke: () => {
      revoked = true
    },
    restore: () => {
      revoked = false
    },
  }

  return {
    fetch,
    requests,
    accessToken: credentials.accessToken,
    chaos,
    oauth: {
      liveRefreshTokens: () => [...refreshTokens.keys()],
      tokenRequests,
      lapse: () => {
        lapsed = true
      },
    },
    add: (seed) => {
      const item = insert(seed)
      record(item.type === 'folder' ? 'ITEM_CREATE' : 'ITEM_UPLOAD', item)
    },
    trash: (id) => trashItem(mustGet(id)),
    rename: (id, name) => {
      const item = mustGet(id)
      item.name = name
      touch(item)
      record('ITEM_RENAME', item)
    },
    move: (id, parentId) => {
      const item = mustGet(id)
      if (mustGet(parentId).type !== 'folder')
        throw new Error(`fake box: ${parentId} is not a folder`)
      item.parentId = parentId
      touch(item)
      record('ITEM_MOVE', item)
    },
    edit: (id, content) => {
      const item = mustGet(id)
      if (item.type !== 'file') throw new Error(`fake box: ${id} is not a file`)
      item.body =
        typeof content === 'string'
          ? { _tag: 'bytes', bytes: encoder.encode(content) }
          : { _tag: 'note', paragraphs: [...content] }
      item.version += 1
      touch(item)
      record('ITEM_UPLOAD', item)
    },
    pendingText: (id, polls) => {
      mustGet(id)
      pending.set(id, polls)
    },
  }
}
