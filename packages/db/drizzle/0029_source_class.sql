CREATE TYPE "public"."source_class" AS ENUM('manual', 'integration', 'ai', 'import', 'seed', 'merge', 'extracted', 'inherited');--> statement-breakpoint
-- Hand-written from here down to the FK/CHECK block (SPA-118). drizzle-kit
-- generated `ADD COLUMN source_class … ; DROP COLUMN source`, which is a
-- correct schema and a silent data loss: every existing row's provenance
-- would collapse to the new column's default. The columns are converted in
-- place instead, and the order is the whole migration.
--
-- Both old columns carry DEFAULT 'manual' typed as the old enum, and a
-- default is checked against the column's type, so the ::text cast fails
-- while the default stands. DROP DEFAULT first, cast, backfill, re-add the
-- default in the new type. (Migration 0010 did the same dance for
-- `entity.kind` without this step only because `kind` has no default.)
--
-- Class mapping, both tables. `manual`, `import`, `seed` and `merge` are
-- the same word in the new enum and survive the cast untouched; the three
-- vendor names do not:
--   clip   → manual       the browser extension is first-party, not an
--                         integration, and a clip is a human clicking a
--                         button (owner, 2026-09-19).
--   gmail  → manual       `integration` is unreachable: the class is a
--   apollo → manual       biconditional with `source_ref`, and there is no
--                         integration row to name. The `integration` table
--                         landed in 0025 (SPA-70), after every row these
--                         columns hold, so no pre-existing row can carry a
--                         ref — `source_ref` is null for all of them, by
--                         construction rather than by choice. The vendor
--                         name is lost, and that is the honest answer: the
--                         alternative is a synthetic integration row core
--                         invented for a plugin nobody installed. Checked
--                         before writing this: the dev seed, the demo seed
--                         and the starter taxonomy write only 'manual',
--                         'import' and 'seed', and no app writer passes a
--                         vendor at all — the single 'apollo' in the tree
--                         was an addIdentityAlias argument in
--                         resolve.test.ts, against a truncated test
--                         database. So on a real deployment this UPDATE
--                         touches nothing, and the mapping loses nothing.
ALTER TABLE "entity" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "entity" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "entity" RENAME COLUMN "source" TO "source_class";--> statement-breakpoint
UPDATE "entity" SET "source_class" = 'manual' WHERE "source_class" IN ('gmail', 'apollo', 'clip');--> statement-breakpoint
ALTER TABLE "entity" ALTER COLUMN "source_class" SET DATA TYPE "public"."source_class" USING "source_class"::"public"."source_class";--> statement-breakpoint
ALTER TABLE "entity" ALTER COLUMN "source_class" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "source_ref" uuid;--> statement-breakpoint
ALTER TABLE "entity_alias" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "entity_alias" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "entity_alias" RENAME COLUMN "source" TO "source_class";--> statement-breakpoint
UPDATE "entity_alias" SET "source_class" = 'manual' WHERE "source_class" IN ('gmail', 'apollo', 'clip');--> statement-breakpoint
ALTER TABLE "entity_alias" ALTER COLUMN "source_class" SET DATA TYPE "public"."source_class" USING "source_class"::"public"."source_class";--> statement-breakpoint
ALTER TABLE "entity_alias" ALTER COLUMN "source_class" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "entity_alias" ADD COLUMN "source_ref" uuid;--> statement-breakpoint
-- The columns are off them, so the vendor-named types can go. Nothing else
-- in public.* referenced either one.
DROP TYPE "public"."entity_source";--> statement-breakpoint
DROP TYPE "public"."alias_source";--> statement-breakpoint
ALTER TABLE "entity" ADD CONSTRAINT "entity_source_ref_integration_id_fk" FOREIGN KEY ("source_ref") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_alias" ADD CONSTRAINT "entity_alias_source_ref_integration_id_fk" FOREIGN KEY ("source_ref") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity" ADD CONSTRAINT "entity_source_ref_invariant" CHECK (("entity"."source_class" = 'integration') = ("entity"."source_ref" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "entity_alias" ADD CONSTRAINT "entity_alias_source_ref_invariant" CHECK (("entity_alias"."source_class" = 'integration') = ("entity_alias"."source_ref" IS NOT NULL));
