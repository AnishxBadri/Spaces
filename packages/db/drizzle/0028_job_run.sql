CREATE TYPE "public"."job_run_status" AS ENUM('running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text NOT NULL,
	"integration_id" uuid,
	"entity_id" uuid,
	"status" "job_run_status" DEFAULT 'running' NOT NULL,
	"attempt" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_run_entity_idx" ON "job_run" USING btree ("entity_id","started_at");--> statement-breakpoint
CREATE INDEX "job_run_queue_idx" ON "job_run" USING btree ("queue","started_at");