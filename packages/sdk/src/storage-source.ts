import { Schema } from 'effect'
import type { Effect } from 'effect'
import type { IsoTimestamp, JsonObject } from './contract.ts'

/**
 * The storage-source provider interface (docs/spec-storage-sources.md §4).
 * Not a job and not a trigger: core calls into it, it calls nothing. A
 * plugin that implements it says `provides: 'storage-source'` in its
 * manifest, and `manifestSchema` refuses such a plugin any job that uses
 * `Facts` or `Ai` — it is a bytes pipe with hints and never decides filing.
 *
 * - Every method returns an `Effect` whose failures are the typed errors
 *   below, never a thrown error.
 * - Bytes are hashed by core on arrival. No member carries a provider hash:
 *   `changeToken` says "this changed", never "these are the bytes".
 */

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** The id or link names nothing this connection can see (deleted, or never shared). */
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {
  id: Schema.String,
}) {}

/** The provider no longer honours this cursor (Drive's 410): re-list the subtree. */
export class CursorExpired extends Schema.TaggedError<CursorExpired>()(
  'CursorExpired',
  { cursor: Schema.String },
) {}

/** The provider said slow down; `retryAfterMs` is its hint, or the plugin's floor. */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  'RateLimited',
  { retryAfterMs: Schema.Number },
) {}

/** The connection's token was refused (revoked, expired past refresh, scope lost). */
export class AuthExpired extends Schema.TaggedError<AuthExpired>()(
  'AuthExpired',
  { reason: Schema.String },
) {}

export type StorageSourceError =
  NotFound | CursorExpired | RateLimited | AuthExpired

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** What a pasted provider URL points at. */
export type LinkTarget =
  { readonly fileId: string } | { readonly folderId: string }

/**
 * One file or folder as the provider lists it.
 *
 * - `mime` is the provider's own: a native Google Doc lists as
 *   `application/vnd.google-apps.document`; `getFile` says what it exports to.
 * - `size` is null where the provider reports none (folders, native docs).
 * - `changeToken` is the provider's version or modified time, opaque and
 *   compared for equality only. It is not a content hash.
 * - `parentId` is null only for a drive root.
 */
export type StorageEntry = {
  readonly id: string
  readonly name: string
  readonly kind: 'file' | 'folder'
  readonly mime: string
  readonly size: number | null
  readonly modifiedAt: IsoTimestamp
  readonly changeToken: string
  readonly parentId: string | null
}

/** One page of a folder. `next` is absent on the last page. */
export type FolderPage = {
  readonly entries: ReadonlyArray<StorageEntry>
  readonly next?: string
}

/** How `listFolder` pages: `cursor` from the previous page's `next`; `pageSize` is a hint. */
export type ListFolderOptions = {
  readonly cursor?: string
  readonly pageSize?: number
}

export type FolderRef = { readonly id: string; readonly name: string }

/**
 * A folder and its ancestry. `parents` runs from the drive root to the
 * immediate parent (breadcrumb order) and is empty for a root; a shared
 * drive's root is a root like My Drive's.
 */
export type StorageFolder = {
  readonly id: string
  readonly name: string
  readonly parents: ReadonlyArray<FolderRef>
}

/**
 * A file's bytes, streamed — never buffered, so a 200 MB file costs no
 * memory here. A native document arrives exported: `mime` and `name` are the
 * export's (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
 * `Memo.docx`), not the listing's.
 */
export type StorageFile = {
  readonly stream: ReadableStream<Uint8Array>
  readonly mime: string
  readonly name: string
  readonly changeToken: string
  /**
   * The folder the file sits in, for `getFolder` to name its path; null for a
   * file at a drive root, absent from a provider that cannot say.
   */
  readonly parentId?: string | null
}

/** One change since a cursor: the entry as it now is, or its removal. */
export type StorageChange =
  | { readonly _tag: 'changed'; readonly entry: StorageEntry }
  | { readonly _tag: 'removed'; readonly id: string }

/** `next` is always present: the cursor to ask from next time. */
export type ChangePage = {
  readonly changes: ReadonlyArray<StorageChange>
  readonly next: string
}

/**
 * What web needs to open the provider's native picker. JSON by type, so it
 * crosses to the browser as is. Never a client secret or a refresh token.
 */
export type PickerConfig = JsonObject

// ---------------------------------------------------------------------------
// The write half (docs/spec-storage-sources.md §6)
// ---------------------------------------------------------------------------

/**
 * What `putFile` uploads. `sha256` is core's hash of the same bytes,
 * lowercase hex: the collision policy compares it with the provider's own
 * checksum of a file already under the name.
 */
export type StorageUpload = {
  readonly stream: ReadableStream<Uint8Array>
  readonly mime: string
  readonly sha256: string
}

/**
 * Where `putFile` landed. `name` is the one used, `(n)` suffix and all.
 * `changeToken` is the file's `changeToken` as this upload left it, when the
 * provider's answer says — what a listing or the change feed reports next,
 * so core can read its own write as no change. Absent, the next poll that
 * sees the file reads it once.
 */
export type PutFileResult = {
  readonly fileId: string
  readonly revisionId: string
  readonly name: string
  readonly changeToken?: string
}

/** A path's folder names: split on `/`, trimmed, empty segments dropped. */
export const pathSegments = (path: string): ReadonlyArray<string> =>
  path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')

/**
 * The `n`th name `putFile` tries in one folder: `name` itself, then
 * `Term sheet (2).pdf`, `Term sheet (3).pdf`. A leading dot belongs to the
 * stem (`.env (2)`).
 */
export const collisionName = (name: string, n: number): string => {
  if (n <= 1) return name
  const dot = name.lastIndexOf('.')
  return dot <= 0
    ? `${name} (${n})`
    : `${name.slice(0, dot)} (${n})${name.slice(dot)}`
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * One port, read and write. The write members are optional so a read-only
 * provider type-checks; `WritableStorageSource` is one that has them.
 */
export type StorageSource = {
  /** A provider URL → what it names; null when it is not this provider's link. */
  readonly resolveLink: (
    url: string,
  ) => Effect.Effect<LinkTarget | null, NotFound | RateLimited | AuthExpired>
  /** One page of a folder's direct children. */
  readonly listFolder: (
    folderId: string,
    options?: ListFolderOptions,
  ) => Effect.Effect<
    FolderPage,
    NotFound | CursorExpired | RateLimited | AuthExpired
  >
  /** A folder with its ancestry up to the drive root — the nesting guard and change filtering read it. */
  readonly getFolder: (
    folderId: string,
  ) => Effect.Effect<StorageFolder, NotFound | RateLimited | AuthExpired>
  /** A file's bytes; a native document exported. */
  readonly getFile: (
    fileId: string,
  ) => Effect.Effect<StorageFile, NotFound | RateLimited | AuthExpired>
  /**
   * Changes since `cursor`, across everything the connection sees. `null`
   * asks for a starting cursor: no changes, and `next` marks now.
   */
  readonly changes: (
    cursor: string | null,
  ) => Effect.Effect<ChangePage, CursorExpired | RateLimited | AuthExpired>
  readonly pickerConfig: () => Effect.Effect<PickerConfig, AuthExpired>
  /**
   * The folder at `path` under `rootId`, each missing segment created — the
   * only way a folder is made. Safe under concurrency: calls racing on one
   * path end with one folder per segment and the same id, though the
   * provider permits duplicate names. `NotFound` names a missing root.
   */
  readonly ensureFolder?: (
    rootId: string,
    path: string,
  ) => Effect.Effect<string, NotFound | RateLimited | AuthExpired>
  /**
   * Upload into a folder. The collision policy is the port's: a file under
   * the name with the same sha gets a new revision; a different sha moves on
   * to `collisionName(name, 2)`, then 3, by the same rule. Never converted
   * to a native document.
   */
  readonly putFile?: (
    folderId: string,
    name: string,
    upload: StorageUpload,
  ) => Effect.Effect<PutFileResult, NotFound | RateLimited | AuthExpired>
  /** Put a file or folder in `folderId` alone. Already there is a no-op. */
  readonly move?: (
    id: string,
    folderId: string,
  ) => Effect.Effect<void, NotFound | RateLimited | AuthExpired>
  /** Give a file or folder exactly `name`. Already so named is a no-op. */
  readonly rename?: (
    id: string,
    name: string,
  ) => Effect.Effect<void, NotFound | RateLimited | AuthExpired>
}

/** The write members of `StorageSource`. */
export type StorageSourceWriteMember =
  'ensureFolder' | 'putFile' | 'move' | 'rename'

/** A provider with the write half. */
export type WritableStorageSource = StorageSource & {
  readonly [K in StorageSourceWriteMember]-?: NonNullable<StorageSource[K]>
}
