CREATE TABLE "meeting_removal" (
	"uid" text PRIMARY KEY NOT NULL,
	"series" boolean DEFAULT false NOT NULL,
	"removed_by" text,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_removal" ADD CONSTRAINT "meeting_removal_removed_by_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;