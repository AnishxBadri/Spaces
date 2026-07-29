import {
  boolean,
  index,
  integer,
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
import { ltree, tsvector } from './helpers'
import { entity } from './entities'
import { user } from './auth'

/**
 * Per-kind side tables. Identity values (domain, email, linkedin, cin) live
 * ONLY in entity_alias — side tables carry attributes, never identity, so
 * there is exactly one source of truth for resolution.
 */

// ---------- company / person ----------

export const company = pgTable('company', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entity.id),
  foundedYear: integer('founded_year'),
  sectors: text('sectors').array(),
  stage: text('stage'),
  geo: text('geo'),
})

export const person = pgTable('person', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entity.id),
  headline: text('headline'),
  geo: text('geo'),
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
    // Materialized path for ancestor/descendant queries (ltree GiST index
    // in migration 0000).
    path: ltree('path').notNull(),
    isSeeded: boolean('is_seeded').notNull().default(false),
  },
  (t) => [uniqueIndex('space_slug_unique').on(t.slug)],
)

// ---------- thesis (a claim you hold — dies often, death is information) ----------

export const thesisStatus = pgEnum('thesis_status', [
  'forming',
  'active',
  'parked',
  'killed',
])

export const thesisConviction = pgEnum('thesis_conviction', [
  'low',
  'medium',
  'high',
])

export const thesis = pgTable('thesis', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entity.id),
  claim: text('claim').notNull(),
  conviction: thesisConviction('conviction').notNull().default('low'),
  status: thesisStatus('status').notNull().default('forming'),
  // Owned but visible to all: someone holds the claim, everyone can see it.
  ownerId: text('owner_id').references(() => user.id),
  openedAt: timestamp('opened_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedReason: text('closed_reason'),
})

/** A thesis spans ≥1 space (defence × autonomy). */
export const thesisSpace = pgTable(
  'thesis_space',
  {
    thesisEntityId: uuid('thesis_entity_id')
      .notNull()
      .references(() => thesis.entityId),
    spaceEntityId: uuid('space_entity_id')
      .notNull()
      .references(() => space.entityId),
  },
  (t) => [primaryKey({ columns: [t.thesisEntityId, t.spaceEntityId] })],
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
 * Markdown is the source of truth ([[Label|entity:uuid]] mention convention,
 * uuid authoritative). Attachment to other entities goes through `link`.
 * Default visibility is shared — private-by-default is the trap that keeps
 * partner #2 writing in Apple Notes.
 */
export const note = pgTable('note', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entity.id),
  title: text('title').notNull().default(''),
  bodyMd: text('body_md').notNull().default(''),
  kind: noteKind('kind').notNull().default('note'),
  authorId: text('author_id')
    .notNull()
    .references(() => user.id),
  visibility: visibility('visibility').notNull().default('shared'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------- document (uploads, decks, and clipped URLs — sources ARE documents) ----------

export const documentKind = pgEnum('document_kind', [
  'deck',
  'memo',
  'dd',
  'cap_table',
  'legal',
  'article',
  'other',
])

export const documentOrigin = pgEnum('document_origin', [
  'upload',
  'gmail_attachment',
  'url',
  'clip',
])

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
    origin: documentOrigin('origin').notNull().default('upload'),
    extractedText: text('extracted_text'),
    // Populated by the extraction worker alongside extracted_text.
    tsv: tsvector('tsv'),
    uploadedBy: text('uploaded_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('document_blob_sha_idx').on(t.blobSha)],
)

/**
 * One embedding model per deployment (pgvector dimension is baked into the
 * column). embedding_model is recorded so a model change can enqueue a full
 * re-embed instead of silently corrupting search. 768 dims fits both
 * nomic-embed-text (Ollama path) and bge-base.
 */
export const documentChunk = pgTable(
  'document_chunk',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => document.entityId),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 768 }),
    embeddingModel: text('embedding_model'),
  },
  (t) => [uniqueIndex('chunk_document_idx_unique').on(t.documentId, t.idx)],
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
