CREATE TABLE "pending_blob" (
	"sha" text PRIMARY KEY NOT NULL,
	"size_bytes" bigint,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prepared_by" text
);
--> statement-breakpoint
ALTER TABLE "pending_blob" ADD CONSTRAINT "pending_blob_prepared_by_user_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;