CREATE TABLE "feed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"site_url" text,
	"name" text NOT NULL,
	"logo_sha" text,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"etag" text,
	"last_modified" text,
	CONSTRAINT "feed_last_status_known" CHECK ("feed"."last_status" IS NULL OR "feed"."last_status" IN ('ok', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "feed_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed_id" uuid NOT NULL,
	"key" text NOT NULL,
	"url" text,
	"title" text NOT NULL,
	"summary" text,
	"published_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"image_url" text,
	"image_sha" text
);
--> statement-breakpoint
CREATE TABLE "feed_space" (
	"feed_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	CONSTRAINT "feed_space_feed_id_space_id_pk" PRIMARY KEY("feed_id","space_id")
);
--> statement-breakpoint
ALTER TABLE "feed" ADD CONSTRAINT "feed_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_item" ADD CONSTRAINT "feed_item_feed_id_feed_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_space" ADD CONSTRAINT "feed_space_feed_id_feed_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_space" ADD CONSTRAINT "feed_space_space_id_space_entity_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("entity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_url_unique" ON "feed" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_item_key_unique" ON "feed_item" USING btree ("feed_id","key");--> statement-breakpoint
CREATE INDEX "feed_item_published_idx" ON "feed_item" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "feed_item_feed_published_idx" ON "feed_item" USING btree ("feed_id","published_at");--> statement-breakpoint
CREATE INDEX "feed_space_space_idx" ON "feed_space" USING btree ("space_id");