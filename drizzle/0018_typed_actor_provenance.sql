CREATE TYPE "public"."actor_type" AS ENUM('user', 'integration', 'system');--> statement-breakpoint
CREATE TYPE "public"."attribute_event_source" AS ENUM('direct', 'default', 'suggestion', 'enrichment', 'import', 'merge', 'seed');--> statement-breakpoint
CREATE TYPE "public"."interaction_source" AS ENUM('manual', 'email_sync', 'forwarding', 'calendar', 'recorder', 'whatsapp', 'import');--> statement-breakpoint
-- Hand-written (SPA-8): the column lands nullable, existing rows are
-- backfilled from the actor FK (a user id means a person attended to the
-- value; null means nobody did — the merge executor's rewrites), then the
-- NOT NULL tightens. The check constraint at the end depends on this order.
ALTER TABLE "attribute_event" ADD COLUMN "actor_type" "actor_type";--> statement-breakpoint
UPDATE "attribute_event" SET "actor_type" = CASE WHEN "actor_id" IS NOT NULL THEN 'user'::"actor_type" ELSE 'system'::"actor_type" END WHERE "actor_type" IS NULL;--> statement-breakpoint
ALTER TABLE "attribute_event" ALTER COLUMN "actor_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD COLUMN "source" "attribute_event_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD COLUMN "suggestion_id" uuid;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD COLUMN "refs" jsonb;--> statement-breakpoint
ALTER TABLE "interaction" ADD COLUMN "source" "interaction_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD CONSTRAINT "attribute_event_actor_invariant" CHECK (("attribute_event"."actor_type" = 'user') = ("attribute_event"."actor_id" IS NOT NULL));