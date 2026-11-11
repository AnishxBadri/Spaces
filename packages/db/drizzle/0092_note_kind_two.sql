-- note_kind drops `scratch` — two labels remain, `note` and `memo`.
--
-- Label mapping applied by the USING clauses below, on both columns typed by
-- the enum (`note.kind` and the nullable `template.note_kind`):
--
--   scratch → note    the only rows that move
--   note    → note
--   memo    → memo
--   NULL    → NULL    template.note_kind only
--
-- Hand-edited, not drizzle's generated SQL. The generator round-trips
-- through `text` and casts straight back with no mapping, so any existing
-- `scratch` row would abort the migration. Postgres cannot drop an enum
-- label in place, so this is rename-create-alter-drop; the default typed by
-- the old enum cannot be cast automatically, hence DROP DEFAULT before the
-- ALTER and SET DEFAULT after. No index, constraint or view depends on
-- note_kind, so the rename leaves nothing else pointing at the old type.

ALTER TYPE "public"."note_kind" RENAME TO "note_kind_old";--> statement-breakpoint
CREATE TYPE "public"."note_kind" AS ENUM('note', 'memo');--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "kind" SET DATA TYPE "public"."note_kind" USING (CASE WHEN "kind"::text = 'scratch' THEN 'note' ELSE "kind"::text END)::"public"."note_kind";--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "kind" SET DEFAULT 'note'::"public"."note_kind";--> statement-breakpoint
ALTER TABLE "template" ALTER COLUMN "note_kind" SET DATA TYPE "public"."note_kind" USING (CASE WHEN "note_kind"::text = 'scratch' THEN 'note' ELSE "note_kind"::text END)::"public"."note_kind";--> statement-breakpoint
DROP TYPE "public"."note_kind_old";
