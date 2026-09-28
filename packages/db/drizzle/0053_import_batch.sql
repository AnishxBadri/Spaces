CREATE TYPE "public"."import_batch_status" AS ENUM('staged', 'planned', 'committed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_mode" AS ENUM('records', 'ledger');--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blob_sha" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sheet" text NOT NULL,
	"sheets" jsonb NOT NULL,
	"header_row" integer,
	"header" jsonb,
	"mode" "import_mode" NOT NULL,
	"target_object_id" uuid,
	"mapping" jsonb,
	"status" "import_batch_status" DEFAULT 'staged' NOT NULL,
	"row_count" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	CONSTRAINT "import_batch_row_count_nonnegative" CHECK ("import_batch"."row_count" >= 0),
	CONSTRAINT "import_batch_ledger_no_target" CHECK ("import_batch"."mode" <> 'ledger' or "import_batch"."target_object_id" is null),
	CONSTRAINT "import_batch_records_target" CHECK ("import_batch"."status" = 'staged' or "import_batch"."mode" = 'ledger' or "import_batch"."target_object_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "import_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_num" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"plan" jsonb,
	"verdict" text,
	"entity_id" uuid,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_target_object_id_object_id_fk" FOREIGN KEY ("target_object_id") REFERENCES "public"."object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batch_blob_sha_idx" ON "import_batch" USING btree ("blob_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "import_row_batch_row_unique" ON "import_row" USING btree ("batch_id","row_num");