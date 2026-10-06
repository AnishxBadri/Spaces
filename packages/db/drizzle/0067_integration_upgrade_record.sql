ALTER TABLE "integration" ADD COLUMN "upgraded_from" text;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "upgraded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "upgrade_migrated" boolean;