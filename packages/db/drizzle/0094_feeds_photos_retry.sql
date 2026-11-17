ALTER TABLE "feed_item" ADD COLUMN "image_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_item" ADD COLUMN "image_failed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "feed_item_image_sha_idx" ON "feed_item" USING btree ("image_sha") WHERE "feed_item"."image_sha" is not null;