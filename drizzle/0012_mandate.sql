CREATE TYPE "public"."mandate_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "mandate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "mandate_status" DEFAULT 'active' NOT NULL,
	"note_entity_id" uuid NOT NULL,
	"stages" text[] DEFAULT '{}' NOT NULL,
	"geos" text[] DEFAULT '{}' NOT NULL,
	"check_min" bigint,
	"check_max" bigint,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mandate" ADD CONSTRAINT "mandate_note_entity_id_note_entity_id_fk" FOREIGN KEY ("note_entity_id") REFERENCES "public"."note"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mandate_one_active" ON "mandate" USING btree ("status") WHERE "mandate"."status" = 'active';