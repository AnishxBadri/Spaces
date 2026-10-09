ALTER TABLE "entity" ADD COLUMN "picture_sha" text;--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "picture_held" boolean DEFAULT false NOT NULL;