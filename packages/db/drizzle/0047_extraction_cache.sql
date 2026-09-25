CREATE TABLE "extraction_cache" (
	"blob_sha" text NOT NULL,
	"schema_key" text NOT NULL,
	"model_id" text NOT NULL,
	"patch" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_cache_blob_sha_schema_key_model_id_pk" PRIMARY KEY("blob_sha","schema_key","model_id")
);
