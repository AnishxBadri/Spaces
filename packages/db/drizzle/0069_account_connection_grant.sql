DROP INDEX "account_connection_unique";--> statement-breakpoint
ALTER TABLE "account_connection" ADD COLUMN "product" text NOT NULL;--> statement-breakpoint
ALTER TABLE "account_connection" ADD COLUMN "external_account_id" text;--> statement-breakpoint
ALTER TABLE "account_connection" ADD COLUMN "scopes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_connection" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_connection" ADD COLUMN "refresh_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_connection" ADD COLUMN "error_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "account_connection_unique" ON "account_connection" USING btree ("user_id","provider","product","external_email");