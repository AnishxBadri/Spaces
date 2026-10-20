CREATE TYPE "public"."email_draft_mode" AS ENUM('new', 'reply', 'reply_all', 'forward');--> statement-breakpoint
CREATE TABLE "email_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"mode" "email_draft_mode" DEFAULT 'new' NOT NULL,
	"in_reply_to_id" uuid,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_draft" ADD CONSTRAINT "email_draft_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_draft" ADD CONSTRAINT "email_draft_in_reply_to_id_interaction_id_fk" FOREIGN KEY ("in_reply_to_id") REFERENCES "public"."interaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_draft_user_idx" ON "email_draft" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "email_draft_reply_idx" ON "email_draft" USING btree ("in_reply_to_id");