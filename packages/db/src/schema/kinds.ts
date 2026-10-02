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
import { user } from './auth'
import type { Json } from '../json'

/** A BlockNote document — an array of blocks. Null until the note has one. */
export type NoteBody = Array<Json>

/**
 * Per-kind side tables. Identity values (domain, email, linkedin, cin) live
 * ONLY in entity_alias — side tables carry attributes, never identity, so
 * there is exactly one source of truth for resolution.
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

// ---------- space (taxonomy — stable, hierarchical, never dies) ----------

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
 * - Visibility defaults to shared (CONTEXT.md "Single user first, team
 *   ready").
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
 * note, a provenance edge, not a genre (CONTEXT.md, "Sources are documents").
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
 * What the provider's copy is doing (`docs/spec-storage-sources.md` §8).
 * - `linked`: the live mapping. `gone`: deleted on their side — we keep ours
 *   and the row says so; an archive that deletes when Drive deletes is not
 *   an archive.
 * - Null for a document no storage source linked.
 */
export const externalStatus = pgEnum('external_status', ['linked', 'gone'])

export const document = pgTable(
  'document',
  {
    entityId: uuid('entity_id')
      .primaryKey()
      .references(() => entity.id),
    // Content-addressed: sha256 of the blob. Same deck emailed twice → one
    // blob, two document rows. Null for url-origin docs with no stored blob.
    blobSha: text('blob_sha'),
    filename: text('filename'),
    mime: text('mime'),
    url: text('url'),
    sizeBytes: integer('size_bytes'),
    kind: documentKind('kind').notNull().default('other'),
    /**
     * How the bytes arrived, as a class and never as a vendor.
     * - Upload, URL and clip are a person in a surface we ship (the extension
     *   is first-party, CONTEXT.md "Plugin architecture"), so all are `manual`.
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
     * Whose account the file came through. `account_connection.id` is a
     * plain uuid primary key and not an entity id, so this column takes **no**
     * `ENTITY_REFS` entry.
     */
    connectionId: uuid('connection_id').references(() => accountConnection.id),
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
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('document_blob_sha_idx').on(t.blobSha),
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
     * - Exactly one writer: `stampSensitivity` (the embed job calls it in the
     *   transaction that inserts the chunks). No second author may appoint
     *   themselves; an insert leaves the default for it to correct.
     * - Binding and filing changes do not restamp, so the column can lag them.
     * - The routing boundary never reads this column — it resolves live
     *   (`resolveSensitivity`): a stale cache where bytes leave the box is a
     *   leak.
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
