CREATE TABLE "view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" jsonb,
	"columns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "view" ADD CONSTRAINT "view_object_id_object_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view" ADD CONSTRAINT "view_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "view_object_idx" ON "view" USING btree ("object_id");