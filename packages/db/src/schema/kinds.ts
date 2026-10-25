import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { ltree, tsvector } from './helpers'
import { entity, sourceClass } from './entities'
import { integration } from './integrations'
import { accountConnection } from './vault'
import { storageBinding } from './storage'
import { user } from './auth'
import type { Json } from '../json'

/** A BlockNote document — an array of blocks. Null until the note has one. */
export type NoteBody = Array<Json>

/**
 * Per-kind side tables. Kind markers only: identity lives in `entity.values`
 * with `entity_alias` as its index, never on a side table.
 */

// ---------- company / person ----------
// Kind markers only: attribute values live in entity.values, so these carry
// no attribute columns.

export const company = pgTable('company', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entity.id),
})

export const person = pgTable('person', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entity.id),
})

// ---------- space (taxonomy — hierarchical, malleable, never dies) ----------

export const space = pgTable(
  'space',
  {
    entityId: uuid('entity_id')
      .primaryKey()
      .references(() => entity.id),
    parentId: uuid('parent_id'),
    slug: text('slug').notNull(),
    // Materialized path for ancestor/descendant queries (ltree GiST index).
    path: ltree('path').notNull(),
    isSeeded: boolean('is_seeded').notNull().default(false),
    /**
     * Archived: out of the tree, the picker and the context climb; filings
     * stay. Never a delete.
     * - One archive stamps the same instant on the space and every live
     *   descendant; Restore clears exactly the rows carrying that instant.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * What belongs here, in one to three sentences — the membership rule a
     * watch's engine and the classify lane read literally. The memo stays the
     * thesis. Null when unwritten; never a placeholder.
     */
    criteria: text('criteria'),
  },
  // Slugs are unique per parent, not globally — one label recurs across
  // branches. `path` stays globally unique by construction.
  // - Roots get their own partial index: NULL parent_id defeats a plain
  //   unique constraint.
  (t) => [
    uniqueIndex('space_slug_per_parent_unique')
      .on(t.parentId, t.slug)
      .where(sql`${t.parentId} is not null`),
    uniqueIndex('space_slug_root_unique')
      .on(t.slug)
      .where(sql`${t.parentId} is null`),
  ],
)

// ---------- entity ↔ space tagging (orthogonal to pipelines) ----------

export const tagSource = pgEnum('tag_source', ['manual', 'ai', 'inherited'])

/**
 * Tags outlive pipelines: a company is tagged Aerospace whether or not it
 * sits in any list. "Tracking, not evaluating" is a first-class state.
 * AI tags land with source='ai' in a review queue, never silently written.
 */
export const entitySpace = pgTable(
  'entity_space',
  {
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => space.entityId),
    source: tagSource('source').notNull().default('manual'),
    confidence: real('confidence'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.spaceId] }),
    index('entity_space_space_idx').on(t.spaceId),
  ],
)

// ---------- note ----------

export const noteKind = pgEnum('note_kind', ['note', 'memo', 'scratch'])
export const visibility = pgEnum('visibility', ['shared', 'private'])

/**
 * A note. `body_json` (BlockNote) is authoritative; BlockNote's markdown
 * export is lossy, so md can't round-trip.
 * - `body_md` is derived on save; it feeds search/embeddings/export
 *   (`[[Label|entity:uuid]]` for mentions). Attachment goes through `link`.
 * - Visibility defaults to shared.
 */
export const note = pgTable('note', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entity.id),
  title: text('title').notNull().default(''),
  bodyJson: jsonb('body_json').$type<NoteBody>(),
  bodyMd: text('body_md').notNull().default(''),
  kind: noteKind('kind').notNull().default('note'),
  // Generated column — derived from title + body_md by Postgres, never
  // written by the app. Title is weighted above body.
  tsv: tsvector('tsv'),
  authorId: text('author_id')
    .notNull()
    .references(() => user.id),
  visibility: visibility('visibility').notNull().default('shared'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------- document (uploads, decks, and clipped URLs — sources ARE documents) ----------

/**
 * A document's genre. No `memo`: an exported memo PDF is `derived_from` a
 * note, a provenance edge, not a genre.
 */
export const documentKind = pgEnum('document_kind', [
  'deck',
  'dd',
  'cap_table',
  'legal',
  'article',
  'other',
])

/**
 * Text-extraction state. Extraction is a worker job, so the row exists before
 * its text does; the UI tells "still working" from "no text we can reach"
 * (scanned PDFs, images) from "we tried and it broke".
 */
export const extractionStatus = pgEnum('extraction_status', [
  'pending',
  'done',
  'unsupported',
  'failed',
])

/**
 * What the provider's copy is doing.
 * - `linked`: the live mapping. `gone`: deleted on their side — we keep ours
 *   and the row says so; an archive that deletes when Drive deletes is not
 *   an archive.
 * - Null for a document no storage source linked.
 */
export const externalStatus = pgEnum('external_status', ['linked', 'gone'])

/**
 * Whether this row's sha is held on disk (a binding's `retain` decides).
 * - `stored`: the blob is ours. `remote`: a `retain: text` binding dropped it
 *   after extraction; the sha, the derived layers and the pointer stay, and
 *   preview and download fetch through the file's connection.
 * - `blob_sha` stays set either way, so this is the column GC, preview and
 *   download read to tell held from discarded.
 */
export const documentBytesState = pgEnum('document_bytes_state', [
  'stored',
  'remote',
])

/**
 * A stored file, keyed by its own entity.
 * - No `sensitive` column, on purpose: `document.entity_id = entity.id`, so a
 *   derived flag here would sit on the same row identity as the authored
 *   `entity.sensitive` and a call site could not tell them apart. The
 *   per-document answer is `sensitivityFor`; the retrieval cache is
 *   `chunk.sensitive`.
 */
export const document = pgTable(
  'document',
  {
    entityId: uuid('entity_id')
      .primaryKey()
      .references(() => entity.id),
    // Content-addressed: sha256 of the blob. Same deck emailed twice → one
    // blob, two document rows. Null for url-origin docs with no stored blob.
    blobSha: text('blob_sha'),
    /** Held or discarded; see `documentBytesState`. */
    bytesState: documentBytesState('bytes_state').notNull().default('stored'),
    filename: text('filename'),
    mime: text('mime'),
    url: text('url'),
    sizeBytes: integer('size_bytes'),
    kind: documentKind('kind').notNull().default('other'),
    /**
     * How the bytes arrived, as a class and never as a vendor.
     * - Upload, URL and clip are a person in a surface we ship (the extension
     *   is first-party), so all are `manual`.
     * - A connector's attachment is `integration` plus `source_ref`.
     */
    sourceClass: sourceClass('source_class').notNull().default('manual'),
    /** The integration that filed the document; null for every other class. */
    sourceRef: uuid('source_ref').references(() => integration.id),
    /**
     * Where the file sits in the provider's tree, kept **verbatim**
     * ("Data room / Legal"). A label and a write-back address, never a key:
     * retrieval scopes by `entity_space` and ltree — the tree is a
     * projection, the graph is the meaning.
     */
    sourcePath: text('source_path'),
    /**
     * The provider's id for the file — the idempotency key of the whole sync.
     * Write-through must not re-import what it just exported, and a
     * cursor-expiry re-list must land on existing rows: both are
     * `on conflict (connection_id, external_id)`.
     */
    externalId: text('external_id'),
    /** The provider's own link — "Open in source" on the row. */
    externalUrl: text('external_url'),
    externalStatus: externalStatus('external_status'),
    /**
     * The provider's revision the bytes at `blob_sha` were read at — the
     * port's `changeToken`, compared for equality only. A change whose token
     * matches is no change: a Docs export is not byte-stable, so the sha
     * cannot say. Null for a document no storage source filed.
     */
    externalRevisionId: text('external_revision_id'),
    /**
     * Whose account the file came through. `account_connection.id` is a
     * plain uuid primary key and not an entity id, so this column takes **no**
     * `ENTITY_REFS` entry.
     */
    connectionId: uuid('connection_id').references(() => accountConnection.id),
    /**
     * The binding whose sync filed it: provenance, not a key (dedupe is
     * `document_connection_external_unique`). Survives a re-bind of the
     * folder; null for anything a binding did not bring, and nulled when
     * the binding is unlinked — the document stays.
     */
    bindingId: uuid('binding_id').references(() => storageBinding.id, {
      onDelete: 'set null',
    }),
    extractedText: text('extracted_text'),
    // Populated by the extraction worker alongside extracted_text.
    tsv: tsvector('tsv'),
    extractionStatus: extractionStatus('extraction_status')
      .notNull()
      .default('pending'),
    // Operator-facing reason when status is failed/unsupported. Surfaced in
    // the UI — swallowing it turns "why is my deck not searchable" into a
    // support thread.
    extractionError: text('extraction_error'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    uploadedBy: text('uploaded_by').references(() => user.id),
    /**
     * Who may read it, read through `canRead` exactly as a note is: private
     * means `author_id` only. A synced mailbox's attachment is born private
     * to the mailbox owner; everything else is born shared.
     */
    visibility: visibility('visibility').notNull().default('shared'),
    /** The member a private document belongs to. A user id, not an entity ref. */
    authorId: text('author_id').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('document_blob_sha_idx').on(t.blobSha),
    index('document_binding_idx').on(t.bindingId),
    // Biconditional, as on entity/entity_alias/interaction: a document the
    // Files tab says arrived "via apollo" must carry the row that says so,
    // and no hand-uploaded deck may borrow one.
    check(
      'document_source_ref_invariant',
      sql`(${t.sourceClass} = 'integration') = (${t.sourceRef} IS NOT NULL)`,
    ),
    // One document per (connection, provider file) — what makes sync loop
    // prevention and the cursor-expiry re-list idempotent. Partial, because
    // the pair is null on every hand-uploaded row.
    uniqueIndex('document_connection_external_unique')
      .on(t.connectionId, t.externalId)
      .where(
        sql`${t.connectionId} is not null and ${t.externalId} is not null`,
      ),
  ],
)

/**
 * A followed document's prior bytes: the sha the row held before the provider's revision advanced it.
 * - Keyed on the provider's revision id, never the sha — an export of an
 *   unchanged Doc hashes differently every time.
 * - `blob_sha` keeps its bytes: `blobIsReferenced` counts this column.
 * - `external_revision_id` is null for bytes filed before revision ids were
 *   kept; nulls never collide on the unique index.
 * - `at` is when the row moved past these bytes.
 */
export const documentRevision = pgTable(
  'document_revision',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => document.entityId),
    blobSha: text('blob_sha').notNull(),
    externalRevisionId: text('external_revision_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_revision_external_unique').on(
      t.documentId,
      t.externalRevisionId,
    ),
    index('document_revision_blob_sha_idx').on(t.blobSha),
  ],
)

/**
 * What a chunk was cut from. `attribute` carries the slug in `source_key` —
 * `close_reason` is a deal attribute, not a column, so it gets no value of
 * its own.
 */
export const chunkSourceKind = pgEnum('chunk_source_kind', [
  'document',
  'note',
  'attribute',
])

/**
 * The retrieval grain for every AI-visible text.
 * - `entity_id`: the document, note, or record whose attribute was chunked;
 *   merge repoints it (ENTITY_REFS `chunk.entity`).
 * - `source_key`: the attribute slug for `attribute`, `''` otherwise. Not
 *   null, so the unique index holds for every row.
 * - One embedding model per deployment (dimension baked into the column);
 *   `embedding_model` lets a model change enqueue a full re-embed.
 * - The HNSW index on `embedding` is hand-written SQL: drizzle-kit cannot
 *   express the operator class.
 * - No space path column: space filtering joins `entity_space` at query time.
 */
export const chunk = pgTable(
  'chunk',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    sourceKind: chunkSourceKind('source_kind').notNull(),
    sourceKey: text('source_key').notNull().default(''),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 768 }),
    embeddingModel: text('embedding_model'),
    /** 1-based page (PDF/PPTX) or sheet the chunk was cut from, when known. */
    page: integer('page'),
    /**
     * A derived cache of the sensitivity resolver, so retrieval filters in
     * SQL before scoring.
     * - One writing module: `stampSensitivity` (the embed job, in the
     *   transaction that inserts the chunks, and the `sensitivity.restamp`
     *   job that lowers) and `raiseSensitivity` (the set-based raise, in the
     *   transaction that writes any input — a record's flag, a filing, a
     *   binding, a document's binding, the workspace default). No second
     *   author may appoint themselves; an insert leaves the default for them
     *   to correct.
     * - Raising is synchronous, lowering is a job: the column may say `true`
     *   late, never `false` late.
     * - The routing boundary never reads this column — it resolves live
     *   (`resolveSensitivity`): a stale cache where bytes leave the box is a
     *   leak. The assembler reads it to leave neighbours' sensitive chunks
     *   out of a cloud-routed prompt (`excludeSensitive`).
     */
    sensitive: boolean('sensitive').notNull().default(false),
  },
  (t) => [
    uniqueIndex('chunk_entity_source_idx_unique').on(
      t.entityId,
      t.sourceKind,
      t.sourceKey,
      t.idx,
    ),
    check(
      'chunk_source_key_invariant',
      sql`(${t.sourceKind} = 'attribute') = (${t.sourceKey} <> '')`,
    ),
  ],
)

// ---------- glossary ----------

/**
 * Scoped to a space ("stage" means different things in aerospace and bio).
 * Auto-linked in note bodies via Aho-Corasick at render time.
 */
export const term = pgTable('term', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entity.id),
  name: text('name').notNull(),
  aliases: text('aliases').array().notNull().default([]),
  definitionMd: text('definition_md').notNull().default(''),
  spaceId: uuid('space_id').references(() => space.entityId),
})
