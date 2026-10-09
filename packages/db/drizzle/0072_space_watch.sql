ALTER TYPE "public"."suggestion_kind" ADD VALUE 'add_record';--> statement-breakpoint
ALTER TYPE "public"."suggestion_kind" ADD VALUE 'file_record';--> statement-breakpoint
CREATE TABLE "space_watch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"settings_hash" text GENERATED ALWAYS AS (md5(settings::text)) STORED NOT NULL,
	"cadence_minutes" integer,
	"state" jsonb,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_watch_cadence_positive" CHECK ("space_watch"."cadence_minutes" IS NULL OR "space_watch"."cadence_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "space_watch_dismissal" (
	"space_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"dismissed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_watch_dismissal_space_id_domain_pk" PRIMARY KEY("space_id","domain")
);
--> statement-breakpoint
ALTER TABLE "suggestion" ALTER COLUMN "entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "space" ADD COLUMN "criteria" text;--> statement-breakpoint
ALTER TABLE "space_watch" ADD CONSTRAINT "space_watch_space_id_space_entity_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_watch" ADD CONSTRAINT "space_watch_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_watch" ADD CONSTRAINT "space_watch_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_watch_dismissal" ADD CONSTRAINT "space_watch_dismissal_space_id_space_entity_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_watch_dismissal" ADD CONSTRAINT "space_watch_dismissal_dismissed_by_user_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "space_watch_lens_unique" ON "space_watch" USING btree ("space_id","integration_id","settings_hash");--> statement-breakpoint
CREATE INDEX "space_watch_integration_idx" ON "space_watch" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestion_open_discovery_unique" ON "suggestion" USING btree (("payload" ->> 'spaceId'),("payload" ->> 'domain')) WHERE "suggestion"."status" = 'open' AND "suggestion"."kind" NOT IN ('attribute_patch', 'note', 'ledger_event', 'identity', 'document_kind', 'space_tag', 'task');--> statement-breakpoint
ALTER TABLE "suggestion" ADD CONSTRAINT "suggestion_entity_present" CHECK ("suggestion"."entity_id" IS NOT NULL OR "suggestion"."kind" NOT IN ('attribute_patch', 'note', 'ledger_event', 'identity', 'document_kind', 'space_tag', 'task'));