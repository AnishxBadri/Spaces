import { Effect } from 'effect'
import {
  AuthExpired,
  CursorExpired,
  NotFound,
  RateLimited,
  collisionName,
  pathSegments,
} from '../storage-source.ts'
import type {
  ChangePage,
  FolderPage,
  FolderRef,
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
} from '../storage-source.ts'
import { makeSha256 } from './storage-source-conformance.ts'
import type {
  StorageSourceChaos,
  StorageSourceChaosFixture,
  StorageSourceFixture,
  StorageSourceWriteFixture,
} from './storage-source-conformance.ts'

/**
 * An in-process Google Drive behind the `StorageSource` read half: a seeded,
 * mutable data-room tree with a My Drive root, a shared-drive root and one
 * native Google Doc that exports to docx bytes. No network, no clock — time
 * is a counter, so every listing is deterministic.
 *
 * - Each seeded file carries an `md5Checksum` the way Drive's API does, and
 *   the fake never surfaces it: core hashes bytes itself.
 * - The toggles (`rateLimit`, `evictCursors`, `vanishAfterList`, `revoke`)
 *   are the chaos cases' seams, gathered as `chaos`; mutators append to the
 *   change feed.
 * - A large file (`largeFiles`) holds no bytes: its stream generates fixed
 *   chunks on demand, so a 200 MB read costs one chunk of memory here.
 */

export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** One item of a seed tree. A `parentId` of null is a drive root. */
export type FakeDriveSeedItem =
  | {
      readonly kind: 'folder'
      readonly id: string
      readonly name: string
      readonly parentId: string | null
    }
  | {
      readonly kind: 'file'
      readonly id: string
      readonly name: string
      readonly parentId: string
      readonly mime: string
      readonly content: string
    }
  | {
      /** A native document: listed under its own mime, read as its export. */
      readonly kind: 'native'
      readonly id: string
      readonly name: string
      readonly parentId: string
      readonly content: string
    }

/**
 * The data room. `dataroom` holds five direct children, so a page size of 2
 * takes three pages, and fourteen files in its whole subtree; `board` is
 * three deep; `sd-portfolio` is a shared drive's root.
 */
export const FAKE_DRIVE_SEED: ReadonlyArray<FakeDriveSeedItem> = [
  { kind: 'folder', id: 'root', name: 'My Drive', parentId: null },
  { kind: 'folder', id: 'dataroom', name: 'Acme Data Room', parentId: 'root' },
  { kind: 'folder', id: 'legal', name: '01 Legal', parentId: 'dataroom' },
  { kind: 'folder', id: 'finance', name: '02 Finance', parentId: 'dataroom' },
  {
    kind: 'native',
    id: 'memo',
    name: 'Investment memo',
    parentId: 'dataroom',
    content: 'Acme investment memo: thesis, risks, terms.',
  },
  {
    kind: 'file',
    id: 'deck',
    name: 'Acme deck.pdf',
    parentId: 'dataroom',
    mime: 'application/pdf',
    content: '%PDF-1.7 Acme seed deck',
  },
  {
    kind: 'file',
    id: 'captable',
    name: 'Cap table.xlsx',
    parentId: 'dataroom',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: 'PK cap table',
  },
  {
    kind: 'file',
    id: 'spa',
    name: 'Share purchase agreement.pdf',
    parentId: 'legal',
    mime: 'application/pdf',
    content: '%PDF-1.7 SPA',
  },
  {
    kind: 'file',
    id: 'termsheet',
    name: 'Term sheet.pdf',
    parentId: 'legal',
    mime: 'application/pdf',
    content: '%PDF-1.7 Acme term sheet',
  },
  {
    kind: 'file',
    id: 'shareholders',
    name: 'Shareholders agreement.pdf',
    parentId: 'legal',
    mime: 'application/pdf',
    content: '%PDF-1.7 SHA',
  },
  {
    kind: 'file',
    id: 'articles',
    name: 'Articles of association.pdf',
    parentId: 'legal',
    mime: 'application/pdf',
    content: '%PDF-1.7 articles',
  },
  {
    kind: 'file',
    id: 'accounts',
    name: 'FY2025 accounts.pdf',
    parentId: 'finance',
    mime: 'application/pdf',
    content: '%PDF-1.7 FY2025 accounts',
  },
  {
    kind: 'file',
    id: 'model',
    name: 'Financial model.xlsx',
    parentId: 'finance',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: 'PK financial model',
  },
  {
    kind: 'file',
    id: 'budget',
    name: 'Budget 2026.xlsx',
    parentId: 'finance',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: 'PK budget 2026',
  },
  { kind: 'folder', id: 'board', name: 'Board', parentId: 'finance' },
  {
    kind: 'file',
    id: 'minutes',
    name: 'Minutes Q3.pdf',
    parentId: 'board',
    mime: 'application/pdf',
    content: '%PDF-1.7 Q3 minutes',
  },
  {
    kind: 'file',
    id: 'minutes-q1',
    name: 'Minutes Q1.pdf',
    parentId: 'board',
    mime: 'application/pdf',
    content: '%PDF-1.7 Q1 minutes',
  },
  {
    kind: 'file',
    id: 'minutes-q2',
    name: 'Minutes Q2.pdf',
    parentId: 'board',
    mime: 'application/pdf',
    content: '%PDF-1.7 Q2 minutes',
  },
  {
    kind: 'file',
    id: 'boardpack',
    name: 'Board pack Q3.pdf',
    parentId: 'board',
    mime: 'application/pdf',
    content: '%PDF-1.7 Q3 board pack',
  },
  { kind: 'folder', id: 'sd-portfolio', name: 'Portfolio', parentId: null },
  {
    kind: 'folder',
    id: 'sd-acme',
    name: 'Acme',
    parentId: 'sd-portfolio',
  },
  {
    kind: 'file',
    id: 'sd-update',
    name: 'Q3 update.pdf',
    parentId: 'sd-acme',
    mime: 'application/pdf',
    content: '%PDF-1.7 Q3 investor update',
  },
]

/**
 * What the conformance suite expects of `FAKE_DRIVE_SEED`, written out
 * separately on purpose: an entry deleted from the seed fails the suite.
 */
export const FAKE_DRIVE_FIXTURE: StorageSourceFixture = {
  dataRoom: {
    folderId: 'dataroom',
    link: 'https://drive.google.com/drive/folders/dataroom',
    childIds: ['legal', 'finance', 'memo', 'deck', 'captable'],
  },
  nativeDoc: {
    fileId: 'memo',
    folderId: 'dataroom',
    link: 'https://docs.google.com/document/d/memo/edit',
    exportMime: DOCX_MIME,
  },
  ancestry: [
    { folderId: 'board', ancestorIds: ['root', 'dataroom', 'finance'] },
    { folderId: 'sd-acme', ancestorIds: ['sd-portfolio'] },
    { folderId: 'root', ancestorIds: [] },
  ],
  foreignLink: 'https://www.dropbox.com/sh/abc/AAA?dl=0',
  missingId: 'never-seeded',
}

/** What the write suite expects of `FAKE_DRIVE_SEED`: My Drive's root takes the writes. */
export const FAKE_DRIVE_WRITE_FIXTURE: StorageSourceWriteFixture = {
  rootId: 'root',
  missingId: 'never-seeded',
}

/**
 * A file whose bytes are never held: `fakeDriveLargeChunks` makes them one
 * chunk at a time when it is read. Not a seed item, so the seed's shape (and
 * every reader of it) is unchanged by a 200 MB file.
 */
export type FakeDriveLargeFile = {
  readonly id: string
  readonly name: string
  readonly parentId: string
  readonly mime: string
  readonly size: number
  /** Bytes per streamed chunk; the last is shorter. */
  readonly chunkSize: number
}

/**
 * The bytes of a large file, generated: chunk `i` is filled with `i % 251`
 * and starts with `i` as a big-endian u32, so a dropped, repeated or
 * reordered chunk changes the SHA-256. Each chunk is a fresh allocation.
 */
export function* fakeDriveLargeChunks(
  file: Pick<FakeDriveLargeFile, 'size' | 'chunkSize'>,
): Generator<Uint8Array, void> {
  for (let at = 0, i = 0; at < file.size; at += file.chunkSize, i += 1) {
    const chunk = new Uint8Array(Math.min(file.chunkSize, file.size - at))
    chunk.fill(i % 251)
    if (chunk.byteLength >= 4) new DataView(chunk.buffer).setUint32(0, i)
    yield chunk
  }
}

/** A 200 MB diligence scan in `legal`, streamed in 16 KiB chunks, the size of a network read. */
export const FAKE_DRIVE_SCAN: FakeDriveLargeFile = {
  id: 'scan',
  name: 'Diligence scan.pdf',
  parentId: 'legal',
  mime: 'application/pdf',
  size: 200 * 1024 * 1024,
  chunkSize: 16 * 1024,
}

/**
 * What the chaos suite expects of `FAKE_DRIVE_SEED` plus `FAKE_DRIVE_SCAN`.
 * The scan's SHA-256 was computed apart from the fake (node's `crypto`), so
 * the suite's streaming hash and the chunk generator check each other.
 */
export const FAKE_DRIVE_CHAOS_FIXTURE: StorageSourceChaosFixture = {
  ...FAKE_DRIVE_FIXTURE,
  vanishingFileId: 'deck',
  largeFile: {
    fileId: FAKE_DRIVE_SCAN.id,
    size: FAKE_DRIVE_SCAN.size,
    sha256: '072c574d74e1e9a0a838f152c6f5644c9be16b89a6fb609d36da2c2f3f03af8b',
  },
}

/** The connection a fake Drive pretends to hold. The secret and refresh token must never leave it. */
export type FakeDriveCredentials = {
  readonly clientId: string
  readonly clientSecret: string
  readonly refreshToken: string
  readonly accessToken: string
  readonly developerKey: string
  readonly appId: string
}

export const FAKE_DRIVE_CREDENTIALS: FakeDriveCredentials = {
  clientId: 'fake-client.apps.googleusercontent.com',
  clientSecret: 'fake-client-secret-do-not-ship',
  refreshToken: 'fake-refresh-token-do-not-ship',
  accessToken: 'fake-access-token',
  developerKey: 'fake-developer-key',
  appId: 'fake-app',
}

/** An item's content: bytes held, or a large file's chunks made on read. */
type Body =
  | { readonly _tag: 'bytes'; readonly bytes: Uint8Array }
  | { readonly _tag: 'lazy'; readonly file: FakeDriveLargeFile }

type Item = {
  readonly id: string
  name: string
  readonly kind: 'folder' | 'file' | 'native'
  parentId: string | null
  readonly mime: string
  body: Body
  /** Drive's own checksum. Kept so a test can prove it is never surfaced. */
  md5Checksum: string
  /** Drive's `sha256Checksum`, computed on first ask; never for a native doc or a large file. */
  sha256: string | undefined
  version: number
  modifiedAt: string
  readonly createdAt: string
  /** Revision ids, oldest first; the last is Drive's `headRevisionId`. */
  readonly revisions: Array<string>
}

/** A folder or file made by a write, under a generated id; Drive permits a duplicate name. */
export type FakeDriveCreate = {
  readonly kind: 'folder' | 'file' | 'native'
  readonly name: string
  readonly parentId: string
  readonly mime?: string
  readonly bytes?: Uint8Array
}

/** What Drive's API reports of an item beyond the port's entry. */
export type FakeDriveFields = {
  readonly createdTime: string
  readonly headRevisionId?: string
  readonly sha256Checksum?: string
}

export type FakeDrive = {
  /** The port, write half included: each write is atomic here, so the fake never forks a path. */
  readonly source: WritableStorageSource
  /** Add a folder or file under an existing folder; a change. */
  readonly add: (item: FakeDriveSeedItem) => void
  /** Delete an item and everything under it; a removal per item. */
  readonly remove: (id: string) => void
  readonly rename: (id: string, name: string) => void
  readonly move: (id: string, parentId: string) => void
  /** New content for a file or native doc: a new `changeToken`. */
  readonly edit: (id: string, content: string) => void
  /** The next `calls` read calls fail `RateLimited` with this hint. */
  readonly rateLimit: (calls: number, retryAfterMs?: number) => void
  /** Every change cursor handed out so far now fails `CursorExpired` (Drive's 410). */
  readonly evictCursors: () => void
  /** The item is deleted right after the next listing that shows it. */
  readonly vanishAfterList: (id: string) => void
  /** Every call fails `AuthExpired` until `restore`. */
  readonly revoke: () => void
  readonly restore: () => void
  /** Drive's `md5Checksum` for an item — what a provider hash looks like. */
  readonly providerHash: (id: string) => string | undefined
  /** A new item under a generated id; a change. Duplicate names are allowed, as Drive's are. */
  readonly create: (item: FakeDriveCreate) => StorageEntry
  /** New bytes for a file as a new revision; a change. */
  readonly upload: (id: string, bytes: Uint8Array) => StorageEntry
  readonly driveFields: (id: string) => FakeDriveFields | undefined
  readonly revisions: (id: string) => ReadonlyArray<string>
  /** An item as the port lists it, read past the toggles. */
  readonly entry: (id: string) => StorageEntry | undefined
  /** Every path under a folder, parents before children, siblings in listing order. */
  readonly tree: (folderId: string) => ReadonlyArray<string>
  /** The toggles above as the chaos suite's handle (`vanish` is `vanishAfterList`). */
  readonly chaos: StorageSourceChaos
}

const encoder = new TextEncoder()

/** A docx is a zip: the export starts with the local file header. */
const docxBytes = (content: string): Uint8Array =>
  encoder.encode(`PK\u0003\u0004word/document.xml ${content}`)

/** A stand-in for Drive's md5: stable per content, and not our SHA-256. */
const fakeMd5 = (bytes: Uint8Array): string => {
  let h = 0x811c9dc5
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0').repeat(4)
}

const sizeOf = (body: Body) =>
  body._tag === 'bytes' ? body.bytes.byteLength : body.file.size

/** Two chunks for held bytes, so a reader that keeps only the first is caught. */
const streamOf = (body: Body): ReadableStream<Uint8Array> => {
  if (body._tag === 'lazy') {
    const chunks = fakeDriveLargeChunks(body.file)
    // Pull-based: a chunk is made only when the reader asks for one.
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
  const bytes = body.bytes.slice()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const half = Math.ceil(bytes.byteLength / 2)
      controller.enqueue(bytes.subarray(0, half))
      if (half < bytes.byteLength) controller.enqueue(bytes.subarray(half))
      controller.close()
    },
  })
}

const BASE_MS = Date.UTC(2026, 0, 1)

const LINK_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/drive(?:\/u\/\d+)?\/folders\/([\w-]+)/,
  /^\/file\/d\/([\w-]+)/,
  /^\/(?:document|spreadsheets|presentation)\/d\/([\w-]+)/,
]

export const makeFakeDrive = (
  options: {
    readonly seed?: ReadonlyArray<FakeDriveSeedItem>
    readonly credentials?: FakeDriveCredentials
    /** Added after the seed; their bytes are generated on read. */
    readonly largeFiles?: ReadonlyArray<FakeDriveLargeFile>
  } = {},
): FakeDrive => {
  const credentials = options.credentials ?? FAKE_DRIVE_CREDENTIALS
  const items = new Map<string, Item>()
  const log: Array<{ readonly id: string; readonly removed: boolean }> = []
  let clock = 0
  let generation = 0
  let limited = 0
  let retryAfterMs = 1000
  let revoked = false
  const vanishing = new Set<string>()

  /** A change cursor: the eviction generation it was issued in, and a log offset. */
  const cursorAt = () => `change:${generation}:${log.length}`

  const tick = () => new Date(BASE_MS + ++clock * 1000).toISOString()

  let made = 0

  /** Not in creation order, as Drive's ids are not: "the lowest id" is no clock. */
  const newId = () =>
    `n${fakeMd5(encoder.encode(`made:${++made}`)).slice(0, 15)}`

  const touch = (item: Item) => {
    item.version += 1
    item.modifiedAt = tick()
  }

  const newRevision = (item: Item) => {
    item.revisions.push(`${item.id}-r${item.revisions.length + 1}`)
  }

  const placeable = (id: string, parentId: string | null) => {
    if (items.has(id)) throw new Error(`fake drive: ${id} exists`)
    if (parentId !== null && items.get(parentId)?.kind !== 'folder')
      throw new Error(`fake drive: ${id}'s parent is not a folder`)
  }

  const put = (
    fields: Pick<Item, 'id' | 'name' | 'kind' | 'parentId' | 'mime' | 'body'>,
    md5Checksum: string,
  ): Item => {
    placeable(fields.id, fields.parentId)
    const now = tick()
    const item: Item = {
      ...fields,
      md5Checksum,
      sha256: undefined,
      version: 1,
      modifiedAt: now,
      createdAt: now,
      revisions: [],
    }
    if (item.kind !== 'folder') newRevision(item)
    items.set(item.id, item)
    return item
  }

  const mimeOf = (kind: Item['kind'], mime: string | undefined) =>
    kind === 'folder'
      ? FOLDER_MIME
      : kind === 'native'
        ? GOOGLE_DOC_MIME
        : (mime ?? 'application/octet-stream')

  const insert = (seed: FakeDriveSeedItem) => {
    const bytes =
      seed.kind === 'folder'
        ? new Uint8Array()
        : seed.kind === 'native'
          ? docxBytes(seed.content)
          : encoder.encode(seed.content)
    put(
      {
        id: seed.id,
        name: seed.name,
        kind: seed.kind,
        parentId: seed.parentId,
        mime: mimeOf(seed.kind, seed.kind === 'file' ? seed.mime : undefined),
        body: { _tag: 'bytes', bytes },
      },
      fakeMd5(bytes),
    )
  }

  const insertLarge = (file: FakeDriveLargeFile) => {
    if (!(file.chunkSize > 0 && file.size >= 0))
      throw new Error(`fake drive: ${file.id} needs a positive chunk size`)
    put(
      {
        id: file.id,
        name: file.name,
        kind: 'file',
        parentId: file.parentId,
        mime: file.mime,
        body: { _tag: 'lazy', file },
      },
      // Never the bytes: hashing 200 MB here would defeat the point.
      fakeMd5(encoder.encode(`${file.id}:${file.size}`)),
    )
  }

  /** A write's new item: a generated id, the parent checked. */
  const create = (spec: FakeDriveCreate): Item => {
    const bytes = spec.bytes ?? new Uint8Array()
    return put(
      {
        id: newId(),
        name: spec.name,
        kind: spec.kind,
        parentId: spec.parentId,
        mime: mimeOf(spec.kind, spec.mime),
        body: { _tag: 'bytes', bytes: bytes.slice() },
      },
      fakeMd5(bytes),
    )
  }

  /** New content for a file or native doc: a new revision and a new `changeToken`. */
  const replaceBody = (item: Item, bytes: Uint8Array) => {
    item.body = { _tag: 'bytes', bytes: bytes.slice() }
    item.md5Checksum = fakeMd5(bytes)
    item.sha256 = undefined
    newRevision(item)
    touch(item)
  }

  /** Drive's sha256Checksum: binary content only, and never a large file's. */
  const sha256Of = (item: Item): string | undefined => {
    if (item.kind !== 'file' || item.body._tag !== 'bytes') return undefined
    if (item.sha256 === undefined) {
      const hash = makeSha256()
      hash.update(item.body.bytes)
      item.sha256 = hash.hex()
    }
    return item.sha256
  }

  /** Oldest first, as `ensureFolder` resolves a duplicate: created time, then id. */
  const byAge = (a: Item, b: Item) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

  for (const seed of options.seed ?? FAKE_DRIVE_SEED) insert(seed)
  for (const file of options.largeFiles ?? []) insertLarge(file)

  const entryOf = (item: Item): StorageEntry => ({
    id: item.id,
    name: item.name,
    kind: item.kind === 'folder' ? 'folder' : 'file',
    mime: item.mime,
    size: item.kind === 'file' ? sizeOf(item.body) : null,
    modifiedAt: item.modifiedAt,
    changeToken: String(item.version),
    parentId: item.parentId,
  })

  const mustGet = (id: string): Item => {
    const item = items.get(id)
    if (!item) throw new Error(`fake drive: no item ${id}`)
    return item
  }

  const children = (folderId: string): Array<Item> =>
    [...items.values()]
      .filter((i) => i.parentId === folderId)
      .sort(
        (a, b) =>
          Number(b.kind === 'folder') - Number(a.kind === 'folder') ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      )

  const removeTree = (id: string) => {
    for (const child of children(id)) removeTree(child.id)
    items.delete(id)
    log.push({ id, removed: true })
  }

  /** The gate every read passes: revoked, then rate limited. */
  const gate = Effect.suspend(
    (): Effect.Effect<void, RateLimited | AuthExpired> => {
      if (revoked)
        return Effect.fail(new AuthExpired({ reason: 'token revoked' }))
      if (limited > 0) {
        limited -= 1
        return Effect.fail(new RateLimited({ retryAfterMs }))
      }
      return Effect.void
    },
  )

  const lookup = (id: string): Effect.Effect<Item, NotFound> =>
    Effect.suspend(() => {
      const item = items.get(id)
      return item ? Effect.succeed(item) : Effect.fail(new NotFound({ id }))
    })

  const folder = (id: string): Effect.Effect<Item, NotFound> =>
    Effect.flatMap(lookup(id), (item) =>
      item.kind === 'folder'
        ? Effect.succeed(item)
        : Effect.fail(new NotFound({ id })),
    )

  const resolveLink = Effect.fn('FakeDrive.resolveLink')(function* (
    url: string,
  ) {
    yield* gate
    const parsed = URL.canParse(url) ? new URL(url) : null
    if (
      parsed === null ||
      !['drive.google.com', 'docs.google.com'].includes(parsed.hostname)
    )
      return null
    const id =
      LINK_PATTERNS.map((p) => p.exec(parsed.pathname)?.[1]).find(
        (m) => m !== undefined,
      ) ?? parsed.searchParams.get('id')
    if (id === null) return null
    const item = yield* lookup(id)
    const target: LinkTarget =
      item.kind === 'folder' ? { folderId: item.id } : { fileId: item.id }
    return target
  })

  const listFolder = Effect.fn('FakeDrive.listFolder')(function* (
    folderId: string,
    page: ListFolderOptions = {},
  ) {
    yield* gate
    yield* folder(folderId)
    const pageSize = Math.max(1, page.pageSize ?? 100)
    let offset = 0
    if (page.cursor !== undefined) {
      const match = /^page:(.+):(\d+)$/.exec(page.cursor)
      if (match?.[1] !== folderId)
        return yield* new CursorExpired({ cursor: page.cursor })
      offset = Number(match[2])
    }
    const all = children(folderId)
    const slice = all.slice(offset, offset + pageSize)
    const end = offset + slice.length
    const result: FolderPage = {
      entries: slice.map(entryOf),
      ...(end < all.length ? { next: `page:${folderId}:${end}` } : {}),
    }
    for (const item of slice) if (vanishing.delete(item.id)) removeTree(item.id)
    return result
  })

  const getFolder = Effect.fn('FakeDrive.getFolder')(function* (
    folderId: string,
  ) {
    yield* gate
    const item = yield* folder(folderId)
    const parents: Array<FolderRef> = []
    for (let up = item.parentId; up !== null;) {
      const parent = mustGet(up)
      parents.unshift({ id: parent.id, name: parent.name })
      up = parent.parentId
    }
    const result: StorageFolder = { id: item.id, name: item.name, parents }
    return result
  })

  const getFile = Effect.fn('FakeDrive.getFile')(function* (fileId: string) {
    yield* gate
    const item = yield* lookup(fileId)
    if (item.kind === 'folder') return yield* new NotFound({ id: fileId })
    const result: StorageFile = {
      stream: streamOf(item.body),
      mime: item.kind === 'native' ? DOCX_MIME : item.mime,
      name: item.kind === 'native' ? `${item.name}.docx` : item.name,
      changeToken: String(item.version),
      parentId: item.parentId,
    }
    return result
  })

  const changes = Effect.fn('FakeDrive.changes')(function* (
    cursor: string | null,
  ) {
    yield* gate
    if (cursor === null) {
      const start: ChangePage = { changes: [], next: cursorAt() }
      return start
    }
    const match = /^change:(\d+):(\d+)$/.exec(cursor)
    const from = Number(match?.[2] ?? -1)
    if (Number(match?.[1] ?? -1) !== generation || from > log.length)
      return yield* new CursorExpired({ cursor })
    // Latest state per id, in the order each id last changed — as Drive does.
    const latest = new Map<string, boolean>()
    for (const { id, removed } of log.slice(from)) {
      latest.delete(id)
      latest.set(id, removed)
    }
    const out: Array<StorageChange> = []
    for (const [id, removed] of latest) {
      const item = items.get(id)
      out.push(
        removed || !item
          ? { _tag: 'removed', id }
          : { _tag: 'changed', entry: entryOf(item) },
      )
    }
    const result: ChangePage = { changes: out, next: cursorAt() }
    return result
  })

  const pickerConfig = Effect.fn('FakeDrive.pickerConfig')(function* () {
    if (revoked) return yield* new AuthExpired({ reason: 'token revoked' })
    const config: PickerConfig = {
      provider: 'google-drive',
      clientId: credentials.clientId,
      appId: credentials.appId,
      developerKey: credentials.developerKey,
      oauthToken: credentials.accessToken,
      views: ['DOCS', 'FOLDERS'],
      supportsSharedDrives: true,
      multiselect: true,
    }
    return config
  })

  const chaos: StorageSourceChaos & {
    readonly rateLimit: (calls: number, retryAfterMs?: number) => void
  } = {
    rateLimit: (calls, hint = 1000) => {
      limited = calls
      retryAfterMs = hint
    },
    evictCursors: () => {
      generation += 1
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

  const renameItem = (item: Item, name: string) => {
    item.name = name
    touch(item)
    log.push({ id: item.id, removed: false })
  }

  const moveItem = (item: Item, parentId: string) => {
    item.parentId = parentId
    touch(item)
    log.push({ id: item.id, removed: false })
  }

  const created = (spec: FakeDriveCreate): Item => {
    const item = create(spec)
    log.push({ id: item.id, removed: false })
    return item
  }

  const uploaded = (item: Item, bytes: Uint8Array) => {
    if (item.kind === 'folder')
      throw new Error(`fake drive: ${item.id} is a folder`)
    replaceBody(item, bytes)
    log.push({ id: item.id, removed: false })
  }

  // The write half. Each decision and its write run in one synchronous step,
  // so concurrent calls cannot interleave between looking and creating.

  const ensureFolder = Effect.fn('FakeDrive.ensureFolder')(function* (
    rootId: string,
    path: string,
  ) {
    yield* gate
    const root = yield* folder(rootId)
    return yield* Effect.sync(() => {
      let at = root
      for (const name of pathSegments(path)) {
        const found = children(at.id)
          .filter((i) => i.kind === 'folder' && i.name === name)
          .sort(byAge)
          .at(0)
        at = found ?? created({ kind: 'folder', name, parentId: at.id })
      }
      return at.id
    })
  })

  const readBytes = (stream: ReadableStream<Uint8Array>) =>
    Effect.promise(
      async () => new Uint8Array(await new Response(stream).arrayBuffer()),
    )

  const putFile = Effect.fn('FakeDrive.putFile')(function* (
    folderId: string,
    name: string,
    upload: StorageUpload,
  ) {
    yield* gate
    yield* folder(folderId)
    const bytes = yield* readBytes(upload.stream)
    // Read while the bytes arrived: the folder may be gone now.
    yield* folder(folderId)
    return yield* Effect.sync((): PutFileResult => {
      for (let n = 1; ; n++) {
        const tried = collisionName(name, n)
        const taken = children(folderId)
          .filter((i) => i.kind !== 'folder' && i.name === tried)
          .sort(byAge)
        const same = taken.find((i) => sha256Of(i) === upload.sha256)
        if (same !== undefined) uploaded(same, bytes)
        const item =
          same ??
          (taken.length === 0
            ? created({
                kind: 'file',
                name: tried,
                parentId: folderId,
                mime: upload.mime,
                bytes,
              })
            : undefined)
        if (item !== undefined)
          return {
            fileId: item.id,
            revisionId: item.revisions.at(-1) ?? String(item.version),
            name: tried,
          }
      }
    })
  })

  const move = Effect.fn('FakeDrive.move')(function* (
    id: string,
    folderId: string,
  ) {
    yield* gate
    const item = yield* lookup(id)
    yield* folder(folderId)
    if (item.parentId !== folderId) moveItem(item, folderId)
  })

  const rename = Effect.fn('FakeDrive.rename')(function* (
    id: string,
    name: string,
  ) {
    yield* gate
    const item = yield* lookup(id)
    if (item.name !== name) renameItem(item, name)
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

  const tree = (folderId: string): Array<string> =>
    children(folderId).flatMap((child) => [
      child.name,
      ...tree(child.id).map((path) => `${child.name}/${path}`),
    ])

  return {
    source,
    add: (seed) => {
      insert(seed)
      log.push({ id: seed.id, removed: false })
    },
    remove: (id) => {
      mustGet(id)
      removeTree(id)
    },
    rename: (id, name) => renameItem(mustGet(id), name),
    move: (id, parentId) => {
      const item = mustGet(id)
      if (mustGet(parentId).kind !== 'folder')
        throw new Error(`fake drive: ${parentId} is not a folder`)
      moveItem(item, parentId)
    },
    edit: (id, content) => {
      const item = mustGet(id)
      uploaded(
        item,
        item.kind === 'native' ? docxBytes(content) : encoder.encode(content),
      )
    },
    create: (spec) => entryOf(created(spec)),
    upload: (id, bytes) => {
      const item = mustGet(id)
      uploaded(item, bytes)
      return entryOf(item)
    },
    driveFields: (id) => {
      const item = items.get(id)
      if (item === undefined) return undefined
      const head = item.revisions.at(-1)
      const sha256Checksum = sha256Of(item)
      return {
        createdTime: item.createdAt,
        ...(head === undefined ? {} : { headRevisionId: head }),
        ...(sha256Checksum === undefined ? {} : { sha256Checksum }),
      }
    },
    revisions: (id) => [...(items.get(id)?.revisions ?? [])],
    entry: (id) => {
      const item = items.get(id)
      return item === undefined ? undefined : entryOf(item)
    },
    tree: (folderId) => {
      mustGet(folderId)
      return tree(folderId)
    },
    rateLimit: chaos.rateLimit,
    evictCursors: chaos.evictCursors,
    vanishAfterList: chaos.vanish,
    revoke: chaos.revoke,
    restore: chaos.restore,
    providerHash: (id) => items.get(id)?.md5Checksum,
    chaos,
  }
}
