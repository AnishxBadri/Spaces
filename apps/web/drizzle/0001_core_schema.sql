CREATE TYPE "public"."alias_kind" AS ENUM('name', 'domain', 'email', 'linkedin', 'cin');--> statement-breakpoint
CREATE TYPE "public"."alias_source" AS ENUM('manual', 'gmail', 'apollo', 'import', 'merge');--> statement-breakpoint
CREATE TYPE "public"."duplicate_status" AS ENUM('open', 'merged', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."entity_kind" AS ENUM('company', 'person', 'organization', 'space', 'thesis', 'note', 'document', 'term');--> statement-breakpoint
CREATE TYPE "public"."entity_source" AS ENUM('manual', 'gmail', 'apollo', 'import', 'clip', 'seed');--> statement-breakpoint
CREATE TYPE "public"."link_relation" AS ENUM('mentions', 'tagged_in', 'evidence_for', 'evidence_against', 'contact_at', 'derived_from', 'supersedes');--> statement-breakpoint
CREATE TYPE "public"."link_source" AS ENUM('manual', 'ai', 'extracted');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('deck', 'memo', 'dd', 'cap_table', 'legal', 'article', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_origin" AS ENUM('upload', 'gmail_attachment', 'url', 'clip');--> statement-breakpoint
CREATE TYPE "public"."note_kind" AS ENUM('note', 'memo', 'scratch');--> statement-breakpoint
CREATE TYPE "public"."tag_source" AS ENUM('manual', 'ai', 'inherited');--> statement-breakpoint
CREATE TYPE "public"."thesis_conviction" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."thesis_status" AS ENUM('forming', 'active', 'parked', 'killed');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('shared', 'private');--> statement-breakpoint
CREATE TYPE "public"."attribute_type" AS ENUM('text', 'select', 'status', 'number', 'currency', 'date', 'checkbox', 'domain', 'email', 'record_reference', 'actor_reference');--> statement-breakpoint
CREATE TYPE "public"."list_kind" AS ENUM('pipeline', 'portfolio', 'watchlist');--> statement-breakpoint
CREATE TYPE "public"."interaction_kind" AS ENUM('email', 'meeting', 'call');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'error', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('llm', 'enrichment', 'search');--> statement-breakpoint
CREATE TYPE "public"."credential_scope" AS ENUM('workspace', 'user');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('active', 'invalid');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'member' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duplicate_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_a" uuid NOT NULL,
	"entity_b" uuid NOT NULL,
	"score" real NOT NULL,
	"reason" jsonb NOT NULL,
	"status" "duplicate_status" DEFAULT 'open' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "entity_kind" NOT NULL,
	"canonical_name" text NOT NULL,
	"merged_into_id" uuid,
	"source" "entity_source" DEFAULT 'manual' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" "alias_kind" NOT NULL,
	"value" text NOT NULL,
	"value_norm" text NOT NULL,
	"is_identity" boolean DEFAULT false NOT NULL,
	"source" "alias_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"relation" "link_relation" NOT NULL,
	"source" "link_source" DEFAULT 'manual' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"winner_id" uuid NOT NULL,
	"loser_id" uuid NOT NULL,
	"merged_by" text NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot" jsonb NOT NULL,
	"unmerged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "company" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"founded_year" integer,
	"sectors" text[],
	"stage" text,
	"geo" text
);
--> statement-breakpoint
CREATE TABLE "document" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"blob_sha" text,
	"filename" text,
	"mime" text,
	"url" text,
	"size_bytes" integer,
	"kind" "document_kind" DEFAULT 'other' NOT NULL,
	"origin" "document_origin" DEFAULT 'upload' NOT NULL,
	"extracted_text" text,
	"tsv" "tsvector",
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(768),
	"embedding_model" text
);
--> statement-breakpoint
CREATE TABLE "entity_space" (
	"entity_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"source" "tag_source" DEFAULT 'manual' NOT NULL,
	"confidence" real,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_space_entity_id_space_id_pk" PRIMARY KEY("entity_id","space_id")
);
--> statement-breakpoint
CREATE TABLE "note" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"kind" "note_kind" DEFAULT 'note' NOT NULL,
	"author_id" text NOT NULL,
	"visibility" "visibility" DEFAULT 'shared' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"headline" text,
	"geo" text
);
--> statement-breakpoint
CREATE TABLE "space" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"path" "ltree" NOT NULL,
	"is_seeded" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"definition_md" text DEFAULT '' NOT NULL,
	"space_id" uuid
);
--> statement-breakpoint
CREATE TABLE "thesis" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"claim" text NOT NULL,
	"conviction" "thesis_conviction" DEFAULT 'low' NOT NULL,
	"status" "thesis_status" DEFAULT 'forming' NOT NULL,
	"owner_id" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_reason" text
);
--> statement-breakpoint
CREATE TABLE "thesis_space" (
	"thesis_entity_id" uuid NOT NULL,
	"space_entity_id" uuid NOT NULL,
	CONSTRAINT "thesis_space_thesis_entity_id_space_entity_id_pk" PRIMARY KEY("thesis_entity_id","space_entity_id")
);
--> statement-breakpoint
CREATE TABLE "list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "list_kind" DEFAULT 'pipeline' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list_attribute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"type" "attribute_type" NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list_entry_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"attr" text NOT NULL,
	"from" jsonb,
	"to" jsonb,
	"actor_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"raw" jsonb NOT NULL,
	"credits_used" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "interaction_kind" NOT NULL,
	"message_id" text,
	"thread_id" text,
	"subject" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction_entity" (
	"interaction_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "interaction_entity_interaction_id_entity_id_pk" PRIMARY KEY("interaction_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text,
	"verb" text NOT NULL,
	"subject_entity_id" uuid NOT NULL,
	"object_entity_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_email" text NOT NULL,
	"tokens_enc" "bytea" NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "credential_scope" DEFAULT 'workspace' NOT NULL,
	"user_id" text,
	"provider" text NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidate" ADD CONSTRAINT "duplicate_candidate_entity_a_entity_id_fk" FOREIGN KEY ("entity_a") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidate" ADD CONSTRAINT "duplicate_candidate_entity_b_entity_id_fk" FOREIGN KEY ("entity_b") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidate" ADD CONSTRAINT "duplicate_candidate_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity" ADD CONSTRAINT "entity_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_alias" ADD CONSTRAINT "entity_alias_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_from_entity_id_entity_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_to_entity_id_entity_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_event" ADD CONSTRAINT "merge_event_winner_id_entity_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_event" ADD CONSTRAINT "merge_event_loser_id_entity_id_fk" FOREIGN KEY ("loser_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_event" ADD CONSTRAINT "merge_event_merged_by_user_id_fk" FOREIGN KEY ("merged_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_document_id_document_entity_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_space" ADD CONSTRAINT "entity_space_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_space" ADD CONSTRAINT "entity_space_space_id_space_entity_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_space" ADD CONSTRAINT "entity_space_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space" ADD CONSTRAINT "space_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term" ADD CONSTRAINT "term_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term" ADD CONSTRAINT "term_space_id_space_entity_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis" ADD CONSTRAINT "thesis_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis" ADD CONSTRAINT "thesis_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_space" ADD CONSTRAINT "thesis_space_thesis_entity_id_thesis_entity_id_fk" FOREIGN KEY ("thesis_entity_id") REFERENCES "public"."thesis"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_space" ADD CONSTRAINT "thesis_space_space_entity_id_space_entity_id_fk" FOREIGN KEY ("space_entity_id") REFERENCES "public"."space"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list" ADD CONSTRAINT "list_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_attribute" ADD CONSTRAINT "list_attribute_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."list"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_entry" ADD CONSTRAINT "list_entry_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."list"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_entry" ADD CONSTRAINT "list_entry_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_entry" ADD CONSTRAINT "list_entry_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_entry_event" ADD CONSTRAINT "list_entry_event_entry_id_list_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."list_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_entry_event" ADD CONSTRAINT "list_entry_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_record" ADD CONSTRAINT "enrichment_record_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_entity" ADD CONSTRAINT "interaction_entity_interaction_id_interaction_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_entity" ADD CONSTRAINT "interaction_entity_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_subject_entity_id_entity_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_object_entity_id_entity_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_connection" ADD CONSTRAINT "account_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_pair_unique" ON "duplicate_candidate" USING btree ("entity_a","entity_b");--> statement-breakpoint
CREATE INDEX "duplicate_status_idx" ON "duplicate_candidate" USING btree ("status") WHERE "duplicate_candidate"."status" = 'open';--> statement-breakpoint
CREATE INDEX "entity_kind_idx" ON "entity" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "entity_merged_into_idx" ON "entity" USING btree ("merged_into_id") WHERE "entity"."merged_into_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "alias_identity_unique" ON "entity_alias" USING btree ("kind","value_norm") WHERE "entity_alias"."is_identity";--> statement-breakpoint
CREATE INDEX "alias_entity_idx" ON "entity_alias" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "link_edge_unique" ON "link" USING btree ("from_entity_id","to_entity_id","relation");--> statement-breakpoint
CREATE INDEX "link_to_idx" ON "link" USING btree ("to_entity_id");--> statement-breakpoint
CREATE INDEX "link_from_idx" ON "link" USING btree ("from_entity_id");--> statement-breakpoint
CREATE INDEX "document_blob_sha_idx" ON "document" USING btree ("blob_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "chunk_document_idx_unique" ON "document_chunk" USING btree ("document_id","idx");--> statement-breakpoint
CREATE INDEX "entity_space_space_idx" ON "entity_space" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "space_slug_unique" ON "space" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "list_attribute_slug_unique" ON "list_attribute" USING btree ("list_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "list_entry_unique" ON "list_entry" USING btree ("list_id","entity_id");--> statement-breakpoint
CREATE INDEX "list_entry_entity_idx" ON "list_entry" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "list_entry_event_entry_idx" ON "list_entry_event" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "enrichment_entity_idx" ON "enrichment_record" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_message_id_unique" ON "interaction" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "interaction_thread_idx" ON "interaction" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "interaction_occurred_idx" ON "interaction" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "interaction_entity_entity_idx" ON "interaction_entity" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "signal_entity_idx" ON "signal" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "activity_subject_idx" ON "activity" USING btree ("subject_entity_id","at");--> statement-breakpoint
CREATE INDEX "activity_at_idx" ON "activity" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_connection_unique" ON "account_connection" USING btree ("user_id","provider","external_email");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_user_unique" ON "credential" USING btree ("scope","provider","user_id");