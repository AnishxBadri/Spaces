import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { user } from './auth'
import { entity } from './entities'
import { accountConnection } from './vault'

/**
 * Storage bindings (docs/spec-storage-sources.md §5): "this folder over there
 * is this node over here". No binding, no sync — a whole Drive is never
 * mirrored.
 */

/** A bound folder, or one followed file. */
export const bindingGrain = pgEnum('binding_grain', ['folder', 'file'])

/** Which way bytes flow: `pull` is Drive → us, `push`/`both` write through (§6). */
export const bindingDirection = pgEnum('binding_direction', [
  'pull',
  'push',
  'both',
])

/** `text` keeps the derived layers and drops the bytes after derivation (§7). */
export const bindingRetain = pgEnum('binding_retain', ['full', 'text'])

/** `inherit` takes the filing's sensitivity; `sensitive` forces the local lane. */
export const bindingSensitivity = pgEnum('binding_sensitivity', [
  'inherit',
  'sensitive',
])

export const bindingStatus = pgEnum('binding_status', [
  'active',
  'error',
  'paused',
])

/**
 * One folder (or file) at a provider, owned by one node.
 * - `ancestor_ids` is the folder's ancestry from `getFolder` at bind time,
 *   root first: the nesting guard is an id-prefix test on it in both
 *   directions, since no listing names a folder's parents.
 * - Unique on (provider, folder_id) across the workspace, not per
 *   connection: two users binding one data room would file every document
 *   twice. (§5.6)
 * - No change cursor here: one poll reads every drive a connection sees, so
 *   the cursor is `account_connection.storage_cursor`.
 */
export const storageBinding = pgTable(
  'storage_binding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The grant the sync reads with. Null once that connection is
     * disconnected: the binding stays, waiting to be re-bound.
     */
    connectionId: uuid('connection_id').references(() => accountConnection.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    grain: bindingGrain('grain').notNull().default('folder'),
    folderId: text('folder_id'),
    fileId: text('file_id'),
    /** The provider's path, verbatim: "My Drive / Ohmium / Data room". */
    folderPath: text('folder_path').notNull(),
    ancestorIds: text('ancestor_ids').array().notNull().default([]),
    /** The space, company, deal or custom record the files land on. */
    targetEntityId: uuid('target_entity_id')
      .notNull()
      .references(() => entity.id),
    direction: bindingDirection('direction').notNull().default('pull'),
    retain: bindingRetain('retain').notNull().default('full'),
    mapSubfolders: boolean('map_subfolders').notNull().default(true),
    sensitivity: bindingSensitivity('sensitivity').notNull().default('inherit'),
    /** The workspace's one write-through root (§6); at most one row. */
    isMirrorRoot: boolean('is_mirror_root').notNull().default(false),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    status: bindingStatus('status').notNull().default('active'),
    /** The provider's message when `status` is `error`. */
    error: text('error'),
    /** Who bound it: the name a duplicate bind is refused with. */
    boundBy: text('bound_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('storage_binding_provider_folder_unique').on(
      t.provider,
      t.folderId,
    ),
    uniqueIndex('storage_binding_mirror_root_unique')
      .on(t.isMirrorRoot)
      .where(sql`${t.isMirrorRoot}`),
    index('storage_binding_target_idx').on(t.targetEntityId),
    // A folder binding names a folder, a file binding a file, never both.
    check(
      'storage_binding_grain_invariant',
      sql`(${t.grain} = 'folder' and ${t.folderId} is not null and ${t.fileId} is null) or (${t.grain} = 'file' and ${t.fileId} is not null and ${t.folderId} is null)`,
    ),
  ],
)

/**
 * A bound file deleted in the app (§8, "deleted in app"): the walk and the
 * poll never file this external id for this binding again.
 * - Written in the document delete's transaction; the provider is untouched.
 * - Unlinking the binding cascades its tombstones away, so a re-bind of the
 *   same folder (a new binding id) brings the file back as new.
 */
export const storageTombstone = pgTable(
  'storage_tombstone',
  {
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => storageBinding.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bindingId, t.externalId] })],
)
