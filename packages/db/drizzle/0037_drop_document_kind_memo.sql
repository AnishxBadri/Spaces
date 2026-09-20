-- document_kind drops `memo` — six labels remain (SPA-25,
-- docs/spec-storage-sources.md §11 delta 3, §2).
--
-- `memo` was a naming collision, not a genre: `note.kind = 'memo'` already
-- means "a note with the flag up", and an exported memo PDF is a document
-- that is `derived_from` a note — an edge link_relation already carries.
-- Keeping both spellings made "memo" mean two unrelated things one join
-- apart.
--
-- Label mapping applied by the USING clause below (identity everywhere the
-- label survives):
--
--   memo      → other        the only row that moves
--   deck      → deck
--   dd        → dd
--   cap_table → cap_table
--   legal     → legal
--   article   → article
--   other     → other
--
-- Hand-edited, not drizzle's generated SQL. The generator emits a
-- round-trip through `text` and then casts straight back with
-- `USING "kind"::document_kind`, which has no mapping in it: every existing
-- `memo` row would raise `invalid input value for enum document_kind:
-- "memo"` and abort the migration. Postgres cannot drop a label from an enum
-- in place either, so this is the rename-create-alter-drop dance, and the
-- dance drops the column default along the way (a default typed by the old
-- enum cannot be cast automatically) — hence the explicit DROP DEFAULT
-- before the ALTER and the SET DEFAULT after it. No index, check constraint
-- or other column depends on document_kind, so the rename leaves nothing
-- else pointing at the old type.

ALTER TYPE "public"."document_kind" RENAME TO "document_kind_old";--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('deck', 'dd', 'cap_table', 'legal', 'article', 'other');--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "kind" SET DATA TYPE "public"."document_kind" USING (CASE WHEN "kind"::text = 'memo' THEN 'other' ELSE "kind"::text END)::"public"."document_kind";--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "kind" SET DEFAULT 'other'::"public"."document_kind";--> statement-breakpoint
DROP TYPE "public"."document_kind_old";
