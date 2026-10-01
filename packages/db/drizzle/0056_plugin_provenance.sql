ALTER TABLE "enrichment_record" ADD COLUMN "integration_id" uuid;--> statement-breakpoint
ALTER TABLE "signal" ADD COLUMN "source_class" "source_class" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "signal" ADD COLUMN "source_ref" uuid;--> statement-breakpoint
ALTER TABLE "enrichment_record" ADD CONSTRAINT "enrichment_record_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_source_ref_integration_id_fk" FOREIGN KEY ("source_ref") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_source_ref_invariant" CHECK (("signal"."source_class" = 'integration') = ("signal"."source_ref" IS NOT NULL));