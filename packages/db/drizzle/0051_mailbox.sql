CREATE TYPE "public"."mailbox_status" AS ENUM('pending', 'ok', 'error');--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE 'mailbox';--> statement-breakpoint
CREATE TABLE "mailbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"address" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 993 NOT NULL,
	"use_tls" boolean DEFAULT true NOT NULL,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"credential_id" uuid NOT NULL,
	"cadence_minutes" integer DEFAULT 5 NOT NULL,
	"last_uid" bigint DEFAULT 0 NOT NULL,
	"last_uid_validity" bigint,
	"last_polled_at" timestamp with time zone,
	"status" "mailbox_status" DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_cadence_range" CHECK ("mailbox"."cadence_minutes" between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "job_run" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_address_unique" ON "mailbox" USING btree ("address");