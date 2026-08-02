CREATE TYPE "public"."template_kind" AS ENUM('note', 'space', 'record');--> statement-breakpoint
CREATE TABLE "template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "template_kind" NOT NULL,
	"object_kind" text,
	"name" text NOT NULL,
	"body" jsonb NOT NULL,
	"suggest_on" text[] DEFAULT '{}' NOT NULL,
	"created_by" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;