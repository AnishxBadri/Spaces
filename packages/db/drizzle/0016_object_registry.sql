ALTER TYPE "public"."entity_kind" ADD VALUE 'custom';--> statement-breakpoint
CREATE TABLE "object" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"singular" text NOT NULL,
	"plural" text NOT NULL,
	"icon" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "attribute_kind_slug_unique";--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "attribute" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "object" ADD CONSTRAINT "object_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "object_slug_unique" ON "object" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "entity" ADD CONSTRAINT "entity_object_id_object_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute" ADD CONSTRAINT "attribute_object_id_object_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_object_slug_unique" ON "attribute" USING btree ("object_id","slug");--> statement-breakpoint
-- Hand-written (SPA-5): seed the three system object rows and backfill the
-- new object_id keys from the legacy enum/kind values. Step 2 (0017) drops
-- the legacy column and tightens object_id to NOT NULL.
INSERT INTO "object" ("slug", "singular", "plural", "is_system")
VALUES
	('companies', 'Company', 'Companies', true),
	('people', 'Person', 'People', true),
	('deals', 'Deal', 'Deals', true)
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "attribute" a
SET "object_id" = o."id"
FROM "object" o
WHERE o."slug" = CASE a."object_kind"
	WHEN 'company' THEN 'companies'
	WHEN 'person' THEN 'people'
	WHEN 'deal' THEN 'deals'
END
AND a."object_id" IS NULL;--> statement-breakpoint
UPDATE "entity" e
SET "object_id" = o."id"
FROM "object" o
WHERE o."slug" = CASE e."kind"::text
	WHEN 'company' THEN 'companies'
	WHEN 'person' THEN 'people'
	WHEN 'deal' THEN 'deals'
END
AND e."object_id" IS NULL;
