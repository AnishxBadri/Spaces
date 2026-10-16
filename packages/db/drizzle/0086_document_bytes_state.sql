CREATE TYPE "public"."document_bytes_state" AS ENUM('stored', 'remote');--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "bytes_state" "document_bytes_state" DEFAULT 'stored' NOT NULL;