ALTER TABLE "attribute_event" ALTER COLUMN "entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD COLUMN "attribute_id" uuid;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD CONSTRAINT "attribute_event_attribute_id_attribute_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."attribute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attribute_event_attribute_idx" ON "attribute_event" USING btree ("attribute_id","at");--> statement-breakpoint
ALTER TABLE "attribute_event" ADD CONSTRAINT "attribute_event_subject" CHECK (("attribute_event"."entity_id" IS NULL) <> ("attribute_event"."attribute_id" IS NULL));