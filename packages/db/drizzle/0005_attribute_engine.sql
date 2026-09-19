CREATE TYPE "public"."attribute_object_kind" AS ENUM('company', 'person', 'deal');--> statement-breakpoint
ALTER TYPE "public"."entity_kind" ADD VALUE 'deal' BEFORE 'space';--> statement-breakpoint
ALTER TYPE "public"."link_relation" ADD VALUE 'references';--> statement-breakpoint
CREATE TABLE "attribute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_kind" "attribute_object_kind" NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"type" "attribute_type" NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"attr_slug" text NOT NULL,
	"from" jsonb,
	"to" jsonb,
	"actor_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attribute" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "list_attribute" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."attribute_type";--> statement-breakpoint
CREATE TYPE "public"."attribute_type" AS ENUM('text', 'number', 'currency', 'date', 'checkbox', 'select', 'multi_select', 'status', 'domain', 'email', 'url', 'phone', 'rating', 'record_reference', 'actor_reference');--> statement-breakpoint
ALTER TABLE "attribute" ALTER COLUMN "type" SET DATA TYPE "public"."attribute_type" USING "type"::"public"."attribute_type";--> statement-breakpoint
ALTER TABLE "list_attribute" ALTER COLUMN "type" SET DATA TYPE "public"."attribute_type" USING "type"::"public"."attribute_type";--> statement-breakpoint
DROP INDEX "link_edge_unique";--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "link" ADD COLUMN "attr_slug" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute" ADD CONSTRAINT "attribute_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD CONSTRAINT "attribute_event_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD CONSTRAINT "attribute_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_kind_slug_unique" ON "attribute" USING btree ("object_kind","slug");--> statement-breakpoint
CREATE INDEX "attribute_event_entity_idx" ON "attribute_event" USING btree ("entity_id","at");--> statement-breakpoint
CREATE INDEX "attribute_event_slug_idx" ON "attribute_event" USING btree ("entity_id","attr_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "link_edge_unique" ON "link" USING btree ("from_entity_id","to_entity_id","relation","attr_slug");--> statement-breakpoint
-- Data migration: copy legacy attr columns into entity.values before dropping.
-- Slugs match the seeded system attributes. sectors is dropped deliberately —
-- markets live in spaces, not attributes (CONTEXT.md classification boundary).
UPDATE "entity" e SET "values" = e."values" || jsonb_strip_nulls(jsonb_build_object(
  'funding_stage', c."stage",
  'location', c."geo",
  'founded_year', c."founded_year"
)) FROM "company" c WHERE c."entity_id" = e."id";--> statement-breakpoint
UPDATE "entity" e SET "values" = e."values" || jsonb_strip_nulls(jsonb_build_object(
  'job_title', p."headline",
  'location', p."geo"
)) FROM "person" p WHERE p."entity_id" = e."id";--> statement-breakpoint
ALTER TABLE "company" DROP COLUMN "founded_year";--> statement-breakpoint
ALTER TABLE "company" DROP COLUMN "sectors";--> statement-breakpoint
ALTER TABLE "company" DROP COLUMN "stage";--> statement-breakpoint
ALTER TABLE "company" DROP COLUMN "geo";--> statement-breakpoint
ALTER TABLE "person" DROP COLUMN "headline";--> statement-breakpoint
ALTER TABLE "person" DROP COLUMN "geo";