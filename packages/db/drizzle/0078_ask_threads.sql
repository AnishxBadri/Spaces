CREATE TYPE "public"."ask_turn_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."ask_turn_state" AS ENUM('streaming', 'answered', 'stopped', 'refused', 'capped', 'no_provider', 'failed', 'empty');--> statement-breakpoint
CREATE TABLE "ask_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ask_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" "ask_turn_role" NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_run_id" uuid,
	"state" "ask_turn_state",
	"route" text,
	"saved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ask_turn_state_invariant" CHECK (("ask_turn"."role" = 'user') = ("ask_turn"."state" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "ask_thread" ADD CONSTRAINT "ask_thread_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_turn" ADD CONSTRAINT "ask_turn_thread_id_ask_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."ask_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_turn" ADD CONSTRAINT "ask_turn_ai_run_id_ai_run_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."ai_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_thread_user_created_idx" ON "ask_thread" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ask_turn_thread_created_idx" ON "ask_turn" USING btree ("thread_id","created_at");