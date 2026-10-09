CREATE TYPE "public"."interaction_document_role" AS ENUM('attachment', 'transcript', 'recording_link');--> statement-breakpoint
ALTER TYPE "public"."suggestion_kind" ADD VALUE 'task';--> statement-breakpoint
CREATE TABLE "interaction_document" (
	"interaction_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"role" "interaction_document_role" NOT NULL,
	CONSTRAINT "interaction_document_interaction_id_document_id_pk" PRIMARY KEY("interaction_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "interaction" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "interaction_document" ADD CONSTRAINT "interaction_document_interaction_id_interaction_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_document" ADD CONSTRAINT "interaction_document_document_id_document_entity_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_document_document_idx" ON "interaction_document" USING btree ("document_id");