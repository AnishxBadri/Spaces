ALTER TABLE "entity" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "entity" ADD CONSTRAINT "entity_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;