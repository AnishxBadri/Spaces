CREATE TYPE "public"."integration_status" AS ENUM('installing', 'enabled', 'degraded', 'disabled');--> statement-breakpoint
CREATE TABLE "integration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capability_id" text NOT NULL,
	"version" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" "integration_status" DEFAULT 'installing' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_id" uuid,
	"connection_id" uuid,
	"error_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attribute_event" DROP CONSTRAINT "attribute_event_actor_invariant";--> statement-breakpoint
ALTER TABLE "attribute_event" ADD COLUMN "actor_ref" uuid;--> statement-breakpoint
-- Hand-written (SPA-70), and the order matters: the old constraint is gone,
-- the column exists, and the rows written before it are reclassified before
-- the biconditional is re-added at the end.
--
-- Until this migration there was no integration table, so an
-- `actor_type = 'integration'` row could not say which integration wrote it —
-- and `resolveEntity` stamped every keyless birth (import, seed, sync) that
-- way for want of a better word. There is no row to backfill them to: no
-- integration was installed, because none could be. `system` is what those
-- writes actually were — a rewrite no person asserted — and is what the same
-- call site passes now. Leaving them as 'integration' would fail the
-- constraint below and block the upgrade.
UPDATE "attribute_event" SET "actor_type" = 'system' WHERE "actor_type" = 'integration' AND "actor_ref" IS NULL;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_connection_id_account_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."account_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD CONSTRAINT "attribute_event_actor_ref_integration_id_fk" FOREIGN KEY ("actor_ref") REFERENCES "public"."integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_event" ADD CONSTRAINT "attribute_event_actor_invariant" CHECK (("attribute_event"."actor_type" = 'user') = ("attribute_event"."actor_id" IS NOT NULL) AND ("attribute_event"."actor_type" = 'integration') = ("attribute_event"."actor_ref" IS NOT NULL));