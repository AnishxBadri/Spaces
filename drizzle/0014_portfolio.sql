CREATE TYPE "public"."distribution_kind" AS ENUM('exit', 'secondary', 'dividend', 'writeoff');--> statement-breakpoint
CREATE TYPE "public"."instrument" AS ENUM('priced', 'safe_post_money', 'safe_pre_money', 'ccd');--> statement-breakpoint
CREATE TYPE "public"."mark_basis" AS ENUM('round_price', 'manual', '409a');--> statement-breakpoint
CREATE TABLE "distribution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"kind" "distribution_kind" NOT NULL,
	"shares_sold" numeric(20, 4),
	"price_per_share" numeric(20, 8),
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency" char(3) NOT NULL,
	"date" date NOT NULL,
	"rate_to_base" numeric(20, 10) NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rate_positive" CHECK ("fx_rate"."rate_to_base" > 0)
);
--> statement-breakpoint
CREATE TABLE "holding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"opened_at" date NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"deal_id" uuid,
	"round_id" uuid,
	"date" date NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"instrument" "instrument" NOT NULL,
	"shares" numeric(20, 4),
	"cap" numeric(20, 4),
	"discount" numeric(7, 4),
	"vehicle" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mark" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"date" date NOT NULL,
	"fair_value" numeric(20, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"basis" "mark_basis" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"raised" numeric(20, 4),
	"currency" char(3),
	"pre_money" numeric(20, 4),
	"post_money" numeric(20, 4),
	"price_per_share" numeric(20, 8),
	"shares_outstanding" numeric(20, 4),
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round_co_investor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"investor_entity_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distribution" ADD CONSTRAINT "distribution_holding_id_holding_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution" ADD CONSTRAINT "distribution_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rate" ADD CONSTRAINT "fx_rate_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding" ADD CONSTRAINT "holding_company_id_entity_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding" ADD CONSTRAINT "holding_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_holding_id_holding_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_deal_id_entity_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_round_id_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."round"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark" ADD CONSTRAINT "mark_holding_id_holding_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark" ADD CONSTRAINT "mark_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round" ADD CONSTRAINT "round_company_id_entity_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round" ADD CONSTRAINT "round_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_co_investor" ADD CONSTRAINT "round_co_investor_round_id_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."round"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_co_investor" ADD CONSTRAINT "round_co_investor_investor_entity_id_entity_id_fk" FOREIGN KEY ("investor_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "distribution_holding_date_idx" ON "distribution" USING btree ("holding_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rate_currency_date_unique" ON "fx_rate" USING btree ("currency","date");--> statement-breakpoint
CREATE UNIQUE INDEX "holding_company_unique" ON "holding" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "investment_holding_date_idx" ON "investment" USING btree ("holding_id","date");--> statement-breakpoint
CREATE INDEX "mark_holding_date_idx" ON "mark" USING btree ("holding_id","date");--> statement-breakpoint
CREATE INDEX "round_company_date_idx" ON "round" USING btree ("company_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "round_co_investor_unique" ON "round_co_investor" USING btree ("round_id","investor_entity_id");