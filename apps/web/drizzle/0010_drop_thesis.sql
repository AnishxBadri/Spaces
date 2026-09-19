-- Thesis removed from the product (2026-08): the Mandate is the strategy
-- surface. Data deletes must precede the enum recreations — a surviving
-- kind='thesis' row or evidence link would fail the ::enum cast below.
DELETE FROM "link" WHERE "relation" IN ('evidence_for', 'evidence_against');--> statement-breakpoint
DELETE FROM "link" WHERE "from_entity_id" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis') OR "to_entity_id" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis');--> statement-breakpoint
DELETE FROM "activity" WHERE "subject_entity_id" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis') OR "object_entity_id" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis');--> statement-breakpoint
DELETE FROM "attribute_event" WHERE "entity_id" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis');--> statement-breakpoint
DELETE FROM "interaction_entity" WHERE "entity_id" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis');--> statement-breakpoint
DELETE FROM "list_entry" WHERE "entity_id" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis');--> statement-breakpoint
DELETE FROM "entity_space" WHERE "entity_id" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis');--> statement-breakpoint
DELETE FROM "entity_alias" WHERE "entity_id" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis');--> statement-breakpoint
DELETE FROM "duplicate_candidate" WHERE "entity_a" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis') OR "entity_b" IN (SELECT "id" FROM "entity" WHERE "kind" = 'thesis');--> statement-breakpoint
DROP TABLE "thesis" CASCADE;--> statement-breakpoint
DROP TABLE "thesis_space" CASCADE;--> statement-breakpoint
DELETE FROM "entity" WHERE "kind" = 'thesis';--> statement-breakpoint
ALTER TABLE "entity" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."entity_kind";--> statement-breakpoint
CREATE TYPE "public"."entity_kind" AS ENUM('company', 'person', 'organization', 'deal', 'space', 'note', 'document', 'term');--> statement-breakpoint
ALTER TABLE "entity" ALTER COLUMN "kind" SET DATA TYPE "public"."entity_kind" USING "kind"::"public"."entity_kind";--> statement-breakpoint
ALTER TABLE "link" ALTER COLUMN "relation" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."link_relation";--> statement-breakpoint
CREATE TYPE "public"."link_relation" AS ENUM('mentions', 'tagged_in', 'contact_at', 'derived_from', 'supersedes', 'references');--> statement-breakpoint
ALTER TABLE "link" ALTER COLUMN "relation" SET DATA TYPE "public"."link_relation" USING "relation"::"public"."link_relation";--> statement-breakpoint
DROP TYPE "public"."thesis_conviction";--> statement-breakpoint
DROP TYPE "public"."thesis_status";
