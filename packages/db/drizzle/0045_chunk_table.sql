-- document_chunk → chunk (SPA-102, ai-12a; docs/spec-ai-substrate.md §7, §9).
--
-- The semantic lane extends from documents to notes and close_reasons, and
-- document_chunk.document_id could only ever point at a document. Reshaped
-- now, while nothing writes chunks, rather than after the table holds real
-- vectors. drizzle-kit generated this as DROP TABLE + CREATE TABLE (its
-- rename prompt needs a TTY); it is hand-edited into an in-place reshape so
-- any row that does exist survives as a `document` chunk. The end state is
-- exactly meta/0045_snapshot.json.
ALTER TABLE "document_chunk" RENAME TO "chunk";--> statement-breakpoint
ALTER TABLE "chunk" RENAME CONSTRAINT "document_chunk_pkey" TO "chunk_pkey";--> statement-breakpoint
ALTER TABLE "chunk" DROP CONSTRAINT "document_chunk_document_id_document_entity_id_fk";--> statement-breakpoint
DROP INDEX "chunk_document_idx_unique";--> statement-breakpoint
ALTER TABLE "chunk" RENAME COLUMN "document_id" TO "entity_id";--> statement-breakpoint
-- A document's entity_id is its entity.id, so every existing row already
-- satisfies the wider foreign key.
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TYPE "public"."chunk_source_kind" AS ENUM('document', 'note', 'attribute');--> statement-breakpoint
-- Every pre-existing row was cut from a document; the default backfills
-- them and is then dropped, so a writer must always say what it chunked.
ALTER TABLE "chunk" ADD COLUMN "source_kind" "chunk_source_kind" DEFAULT 'document' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ALTER COLUMN "source_kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "source_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "page" integer;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- `sensitive` is a derived cache with exactly one writer: stampSensitivity
-- (storage-18). Nothing in this migration or this slice writes it, and no
-- second author may appoint themselves. The routing boundary never reads it —
-- it resolves live through apps/web/src/lib/ai/sensitivity.ts.
COMMENT ON COLUMN "chunk"."sensitive" IS 'Derived cache of the sensitivity resolver (ai-26). One writer: stampSensitivity (storage-18); nothing in SPA-102 writes it. The routing boundary reads apps/web/src/lib/ai/sensitivity.ts instead, never this column.';--> statement-breakpoint
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_source_key_invariant" CHECK (("chunk"."source_kind" = 'attribute') = ("chunk"."source_key" <> ''));--> statement-breakpoint
CREATE UNIQUE INDEX "chunk_entity_source_idx_unique" ON "chunk" USING btree ("entity_id","source_kind","source_key","idx");--> statement-breakpoint
-- No space_path column: a document can be filed in many spaces and one ltree
-- column cannot hold that, so space filtering joins entity_space at query
-- time. Denormalizing it is a later optimization, if EXPLAIN demands it.
--
-- Hand-written, as in 0002_search_indexes.sql: drizzle-kit cannot express the
-- vector_cosine_ops operator class, so it neither generates nor sees this
-- index. It is dropped and recreated against the new table rather than
-- carried along by the rename, so the index's definition is readable here.
DROP INDEX IF EXISTS "chunk_embedding_hnsw_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunk_embedding_hnsw_idx" ON "chunk" USING hnsw ("embedding" vector_cosine_ops);
