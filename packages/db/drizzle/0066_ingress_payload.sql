CREATE TABLE "ingress_payload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"headers" jsonb NOT NULL,
	"body" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "webhook_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "ingress_payload" ADD CONSTRAINT "ingress_payload_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingress_payload_received_idx" ON "ingress_payload" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "ingress_payload_integration_idx" ON "ingress_payload" USING btree ("integration_id","received_at");--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_webhook_credential_id_credential_id_fk" FOREIGN KEY ("webhook_credential_id") REFERENCES "public"."credential"("id") ON DELETE no action ON UPDATE no action;