ALTER TABLE "email_draft" ADD COLUMN "send_error" text;--> statement-breakpoint
ALTER TABLE "email_draft" ADD COLUMN "send_failed_at" timestamp with time zone;