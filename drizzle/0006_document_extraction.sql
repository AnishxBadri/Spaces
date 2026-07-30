CREATE TYPE "public"."extraction_status" AS ENUM('pending', 'done', 'unsupported', 'failed');--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "extraction_status" "extraction_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "extraction_error" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "extracted_at" timestamp with time zone;