CREATE TYPE "public"."ai_lane" AS ENUM('extract', 'classify', 'synthesize', 'embed', 'vision', 'research');--> statement-breakpoint
CREATE TYPE "public"."ai_sensitivity" AS ENUM('normal', 'sensitive');--> statement-breakpoint
CREATE TABLE "ai_route" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lane" "ai_lane" NOT NULL,
	"sensitivity" "ai_sensitivity" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_route_lane_sensitivity_unique" UNIQUE("lane","sensitivity")
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_run_id" uuid,
	"lane" "ai_lane" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"caller_type" "actor_type" NOT NULL,
	"caller_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_caller_invariant" CHECK (("ai_usage"."caller_type" = 'system') = ("ai_usage"."caller_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "ai_usage_at_idx" ON "ai_usage" USING btree ("at");