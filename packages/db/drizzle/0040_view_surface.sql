CREATE TYPE "public"."view_surface" AS ENUM('object', 'document');--> statement-breakpoint
ALTER TABLE "view" ALTER COLUMN "object_id" DROP NOT NULL;--> statement-breakpoint
-- Hand-written: drizzle-kit emits the NOT NULL column in one statement, which
-- refuses on a table that already has rows. Add it nullable, backfill every
-- existing view to the only surface that existed (`object` — object_id was
-- NOT NULL until the statement above), then tighten. D2, views-1.
ALTER TABLE "view" ADD COLUMN "surface" "view_surface";--> statement-breakpoint
UPDATE "view" SET "surface" = 'object';--> statement-breakpoint
ALTER TABLE "view" ALTER COLUMN "surface" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "view" ADD CONSTRAINT "view_surface_object_id" CHECK (("view"."surface" = 'object') = ("view"."object_id" is not null));
