-- Hand-written in full (SPA-137), on the pattern 0029 set. drizzle-kit
-- generated `ADD COLUMN source_class … ; DROP COLUMN origin/source`, which is
-- a correct final schema and a silent data loss: every existing row's
-- provenance would collapse to the new column's default and the old value
-- would be dropped unread. The columns are converted in place instead, and
-- the order is the whole migration.
--
-- `interaction.source` (DEFAULT 'manual') and `document.origin` (DEFAULT
-- 'upload') both carry a default typed as the old enum, and a default is
-- checked against the column's type, so the ::text cast fails while the
-- default stands. DROP DEFAULT first, cast, rename, backfill, cast into
-- `source_class`, re-add the default in the new type.
--
-- The last two vendor-named enums. `source_class` itself and the
-- `source_ref → integration.id` referent (D1) landed in 0029; this migration
-- only moves two more columns onto them, after which no shared enum in
-- `public.*` names a vendor.
--
-- ---------- Old value → class ----------
--
-- interaction_source (7 values):
--   manual      → manual        same word, survives the cast untouched
--   import      → import        same word, survives the cast untouched
--   email_sync  → manual        \
--   forwarding  → manual         |  `integration` is unreachable for all
--   calendar    → manual         |  five: the class is a biconditional with
--   recorder    → manual         |  `source_ref`, and no integration row
--   whatsapp    → manual        /   predates them — the `integration` table
--                                   landed in 0025 (SPA-70), after every row
--                                   these columns can hold. The body's own
--                                   criterion ("land integration with a null
--                                   source_ref") is impossible under the
--                                   constraint; this is the amendment, and
--                                   it is the SPA-118 precedent verbatim.
--
-- document_origin (4 values):
--   upload           → manual   a person dropped a file on the Files tab
--   url              → manual   \  both are first-party channels, not
--   clip             → manual   /  integrations: the browser extension ships
--                                  with the product and a clip is a human
--                                  clicking a button (CONTEXT.md "Plugin
--                                  architecture"; owner, 2026-09-19, recorded
--                                  by SPA-118 for `entity_source.clip`).
--   gmail_attachment → manual      unreachable as `integration`, as above.
--                                  When a connector lands, a Gmail
--                                  attachment is `integration` + the row
--                                  that names it — never an enum value
--                                  (docs/spec-storage-sources.md §11.2).
--
-- What the vendor UPDATEs actually touch, audited before writing this: the
-- only writer of a vendor value anywhere in the tree's history is the dev
-- seed's `source: kind === 'email' ? 'email_sync' : 'manual'`
-- (apps/web/src/lib/seeds/dev.ts, `git log -S email_sync`). No app writer
-- passes one, `document.origin` was written as 'upload' at all four sites,
-- and `url`/`clip`/`gmail_attachment` have never had a writer at all. So on a
-- real deployment these statements lose nothing that was ever recorded.
--
-- One knowing divergence: the dev seed now writes `seed` for the interactions
-- and documents it generates (they are fixtures, and their entity rows have
-- said `seed` since 0029), while this backfill maps its old rows to `manual`.
-- A migration cannot tell a seeded row from a hand-logged one without
-- pattern-matching `message_id`, and dev data is reseeded rather than
-- migrated for its content, so the discrepancy is one reseed wide and exists
-- in no production database.

ALTER TABLE "interaction" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "interaction" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "interaction" RENAME COLUMN "source" TO "source_class";--> statement-breakpoint
UPDATE "interaction" SET "source_class" = 'manual' WHERE "source_class" IN ('email_sync', 'forwarding', 'calendar', 'recorder', 'whatsapp');--> statement-breakpoint
ALTER TABLE "interaction" ALTER COLUMN "source_class" SET DATA TYPE "public"."source_class" USING "source_class"::"public"."source_class";--> statement-breakpoint
ALTER TABLE "interaction" ALTER COLUMN "source_class" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "interaction" ADD COLUMN "source_ref" uuid;--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "origin" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "origin" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "document" RENAME COLUMN "origin" TO "source_class";--> statement-breakpoint
UPDATE "document" SET "source_class" = 'manual' WHERE "source_class" IN ('upload', 'gmail_attachment', 'url', 'clip');--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "source_class" SET DATA TYPE "public"."source_class" USING "source_class"::"public"."source_class";--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "source_class" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "source_ref" uuid;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_source_ref_integration_id_fk" FOREIGN KEY ("source_ref") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_source_ref_integration_id_fk" FOREIGN KEY ("source_ref") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_source_ref_invariant" CHECK (("interaction"."source_class" = 'integration') = ("interaction"."source_ref" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_source_ref_invariant" CHECK (("document"."source_class" = 'integration') = ("document"."source_ref" IS NOT NULL));--> statement-breakpoint
-- The columns are off them, so the last two vendor-named types can go.
-- Nothing else in public.* referenced either one.
DROP TYPE "public"."interaction_source";--> statement-breakpoint
DROP TYPE "public"."document_origin";
