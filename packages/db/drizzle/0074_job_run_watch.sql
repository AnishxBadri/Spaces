ALTER TABLE "job_run" ADD COLUMN "watch_id" uuid;--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_watch_id_space_watch_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."space_watch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_run_watch_idx" ON "job_run" USING btree ("watch_id","started_at");