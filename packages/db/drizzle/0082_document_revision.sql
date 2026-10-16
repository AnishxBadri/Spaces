CREATE TABLE "document_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"blob_sha" text NOT NULL,
	"external_revision_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "external_revision_id" text;--> statement-breakpoint
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_document_id_document_entity_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_revision_external_unique" ON "document_revision" USING btree ("document_id","external_revision_id");--> statement-breakpoint
CREATE INDEX "document_revision_blob_sha_idx" ON "document_revision" USING btree ("blob_sha");