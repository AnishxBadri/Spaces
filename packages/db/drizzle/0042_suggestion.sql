CREATE TYPE "public"."suggestion_kind" AS ENUM('attribute_patch', 'note', 'ledger_event', 'identity', 'document_kind');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('open', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" "suggestion_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"rationale" text,
	"refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"run_id" uuid,
	"proposed_by_type" "actor_type" NOT NULL,
	"proposed_by_id" text,
	"status" "suggestion_status" DEFAULT 'open' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestion_decision_invariant" CHECK (("suggestion"."status" = 'open') = ("suggestion"."decided_at" IS NULL) AND ("suggestion"."status" = 'open') = ("suggestion"."decided_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "suggestion" ADD CONSTRAINT "suggestion_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion" ADD CONSTRAINT "suggestion_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suggestion_entity_status_idx" ON "suggestion" USING btree ("entity_id","status");--> statement-breakpoint
ALTER TABLE "attribute_event" ADD CONSTRAINT "attribute_event_suggestion_id_suggestion_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestion"("id") ON DELETE set null ON UPDATE no action;