CREATE TYPE "public"."interaction_note_role" AS ENUM('recorder_note', 'typed_notes');--> statement-breakpoint
CREATE TABLE "interaction_note" (
	"interaction_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"role" "interaction_note_role" NOT NULL,
	CONSTRAINT "interaction_note_interaction_id_note_id_pk" PRIMARY KEY("interaction_id","note_id")
);
--> statement-breakpoint
ALTER TABLE "account_connection" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "interaction_note" ADD CONSTRAINT "interaction_note_interaction_id_interaction_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_note" ADD CONSTRAINT "interaction_note_note_id_note_entity_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_note_note_idx" ON "interaction_note" USING btree ("note_id");