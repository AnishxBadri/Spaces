ALTER TABLE "distribution" ADD COLUMN "reverses_id" uuid;--> statement-breakpoint
ALTER TABLE "distribution" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "reverses_id" uuid;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "mark" ADD COLUMN "reverses_id" uuid;--> statement-breakpoint
ALTER TABLE "mark" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "distribution" ADD CONSTRAINT "distribution_reverses_id_distribution_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."distribution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_reverses_id_investment_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."investment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark" ADD CONSTRAINT "mark_reverses_id_mark_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."mark"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_reverses_unique" ON "distribution" USING btree ("reverses_id") WHERE "distribution"."reverses_id" is not null;--> statement-breakpoint
CREATE INDEX "distribution_batch_idx" ON "distribution" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_reverses_unique" ON "investment" USING btree ("reverses_id") WHERE "investment"."reverses_id" is not null;--> statement-breakpoint
CREATE INDEX "investment_batch_idx" ON "investment" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mark_reverses_unique" ON "mark" USING btree ("reverses_id") WHERE "mark"."reverses_id" is not null;--> statement-breakpoint
CREATE INDEX "mark_batch_idx" ON "mark" USING btree ("batch_id");