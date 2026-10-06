CREATE TABLE "embed_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"text" text NOT NULL,
	"embedding" real[],
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "embed_request_created_idx" ON "embed_request" USING btree ("created_at");