import { Effect } from 'effect'
import {
  AuthExpired,
  CursorExpired,
  NotFound,
  RateLimited,
} from '../storage-source.ts'
import type {
  ChangePage,
  FolderPage,
  FolderRef,
  LinkTarget,
  ListFolderOptions,
  PickerConfig,
  StorageChange,
  StorageEntry,
  StorageFile,
  StorageFolder,
  StorageSource,
} from '../storage-source.ts'
import type { StorageSourceFixture } from './storage-source-conformance.ts'

/**
 * An in-process Google Drive behind the `StorageSource` read half: a seeded,
 * mutable data-room tree with a My Drive root, a shared-drive root and one
 * native Google Doc that exports to docx bytes. No network, no clock — time
 * is a counter, so every listing is deterministic.
 *
 * - Each seeded file carries an `md5Checksum` the way Drive's API does, and
 *   the fake never surfaces it: core hashes bytes itself.
 * - The toggles (`rateLimit`, `evictCursors`, `vanishAfterList`, `revoke`)
 *   are the chaos cases' seams; mutators append to the change feed.
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
 * takes three pages; `board` is three deep; `sd-portfolio` is a shared
 * drive's root.
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
  { kind: 'folder', id: 'board', name: 'Board', parentId: 'finance' },
  {
    kind: 'file',
    id: 'minutes',
    name: 'Minutes Q3.pdf',
    parentId: 'board',
    mime: 'application/pdf',
    content: '%PDF-1.7 Q3 minutes',
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

type Item = {
  readonly id: string
  name: string
  readonly kind: 'folder' | 'file' | 'native'
  parentId: string | null
  readonly mime: string
  bytes: Uint8Array
  /** Drive's own checksum. Kept so a test can prove it is never surfaced. */
  md5Checksum: string
  version: number
  modifiedAt: string
}

export type FakeDrive = {
  readonly source: StorageSource
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

  const touch = (item: Item) => {
    item.version += 1
    item.modifiedAt = tick()
  }

  const insert = (seed: FakeDriveSeedItem) => {
    if (items.has(seed.id)) throw new Error(`fake drive: ${seed.id} exists`)
    if (seed.parentId !== null && items.get(seed.parentId)?.kind !== 'folder')
      throw new Error(`fake drive: ${seed.id}'s parent is not a folder`)
    const bytes =
      seed.kind === 'folder'
        ? new Uint8Array()
        : seed.kind === 'native'
          ? docxBytes(seed.content)
          : encoder.encode(seed.content)
    items.set(seed.id, {
      id: seed.id,
      name: seed.name,
      kind: seed.kind,
      parentId: seed.parentId,
      mime:
        seed.kind === 'folder'
          ? FOLDER_MIME
          : seed.kind === 'native'
            ? GOOGLE_DOC_MIME
            : seed.mime,
      bytes,
      md5Checksum: fakeMd5(bytes),
      version: 1,
      modifiedAt: tick(),
    })
  }

  for (const seed of options.seed ?? FAKE_DRIVE_SEED) insert(seed)

  const entryOf = (item: Item): StorageEntry => ({
    id: item.id,
    name: item.name,
    kind: item.kind === 'folder' ? 'folder' : 'file',
    mime: item.mime,
    size: item.kind === 'file' ? item.bytes.byteLength : null,
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
    const bytes = item.bytes.slice()
    const result: StorageFile = {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          // Two chunks, so a reader that keeps only the first is caught.
          const half = Math.ceil(bytes.byteLength / 2)
          controller.enqueue(bytes.subarray(0, half))
          if (half < bytes.byteLength) controller.enqueue(bytes.subarray(half))
          controller.close()
        },
      }),
      mime: item.kind === 'native' ? DOCX_MIME : item.mime,
      name: item.kind === 'native' ? `${item.name}.docx` : item.name,
      changeToken: String(item.version),
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

  const source: StorageSource = {
    resolveLink,
    listFolder,
    getFolder,
    getFile,
    changes,
    pickerConfig,
  }

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
    rename: (id, name) => {
      const item = mustGet(id)
      item.name = name
      touch(item)
      log.push({ id, removed: false })
    },
    move: (id, parentId) => {
      const item = mustGet(id)
      if (mustGet(parentId).kind !== 'folder')
        throw new Error(`fake drive: ${parentId} is not a folder`)
      item.parentId = parentId
      touch(item)
      log.push({ id, removed: false })
    },
    edit: (id, content) => {
      const item = mustGet(id)
      if (item.kind === 'folder')
        throw new Error(`fake drive: ${id} is a folder`)
      item.bytes =
        item.kind === 'native' ? docxBytes(content) : encoder.encode(content)
      item.md5Checksum = fakeMd5(item.bytes)
      touch(item)
      log.push({ id, removed: false })
    },
    rateLimit: (calls, hint = 1000) => {
      limited = calls
      retryAfterMs = hint
    },
    evictCursors: () => {
      generation += 1
    },
    vanishAfterList: (id) => {
      mustGet(id)
      vanishing.add(id)
    },
    revoke: () => {
      revoked = true
    },
    restore: () => {
      revoked = false
    },
    providerHash: (id) => items.get(id)?.md5Checksum,
  }
}
