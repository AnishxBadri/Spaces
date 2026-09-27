CREATE TYPE "public"."ai_run_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "ai_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" text NOT NULL,
	"entity_id" uuid,
	"started_by_type" "actor_type" NOT NULL,
	"started_by_id" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_id" uuid,
	"tokens_in" integer,
	"tokens_out" integer,
	"status" "ai_run_status" DEFAULT 'running' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ai_run_started_by_invariant" CHECK (("ai_run"."started_by_type" = 'system') = ("ai_run"."started_by_id" IS NULL)),
	CONSTRAINT "ai_run_finished_invariant" CHECK (("ai_run"."status" = 'running') = ("ai_run"."finished_at" IS NULL) AND ("ai_run"."error" IS NULL OR "ai_run"."status" = 'failed'))
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_run_started_at_idx" ON "ai_run" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "ai_run_entity_idx" ON "ai_run" USING btree ("entity_id");--> statement-breakpoint
ALTER TABLE "suggestion" ADD CONSTRAINT "suggestion_run_id_ai_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_run_id_ai_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suggestion_run_idx" ON "suggestion" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_usage_run_idx" ON "ai_usage" USING btree ("run_id");