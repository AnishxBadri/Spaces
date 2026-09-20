ALTER TABLE "interaction" ADD COLUMN "note_id" uuid;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_note_id_note_entity_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_note_unique" ON "interaction" USING btree ("note_id");