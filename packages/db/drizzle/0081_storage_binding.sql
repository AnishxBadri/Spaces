CREATE TYPE "public"."binding_direction" AS ENUM('pull', 'push', 'both');--> statement-breakpoint
CREATE TYPE "public"."binding_grain" AS ENUM('folder', 'file');--> statement-breakpoint
CREATE TYPE "public"."binding_retain" AS ENUM('full', 'text');--> statement-breakpoint
CREATE TYPE "public"."binding_sensitivity" AS ENUM('inherit', 'sensitive');--> statement-breakpoint
CREATE TYPE "public"."binding_status" AS ENUM('active', 'error', 'paused');--> statement-breakpoint
CREATE TABLE "storage_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"provider" text NOT NULL,
	"grain" "binding_grain" DEFAULT 'folder' NOT NULL,
	"folder_id" text,
	"file_id" text,
	"folder_path" text NOT NULL,
	"ancestor_ids" text[] DEFAULT '{}' NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"direction" "binding_direction" DEFAULT 'pull' NOT NULL,
	"retain" "binding_retain" DEFAULT 'full' NOT NULL,
	"map_subfolders" boolean DEFAULT true NOT NULL,
	"sensitivity" "binding_sensitivity" DEFAULT 'inherit' NOT NULL,
	"is_mirror_root" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"status" "binding_status" DEFAULT 'active' NOT NULL,
	"error" text,
	"bound_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_binding_grain_invariant" CHECK (("storage_binding"."grain" = 'folder' and "storage_binding"."folder_id" is not null and "storage_binding"."file_id" is null) or ("storage_binding"."grain" = 'file' and "storage_binding"."file_id" is not null and "storage_binding"."folder_id" is null))
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "binding_id" uuid;--> statement-breakpoint
ALTER TABLE "account_connection" ADD COLUMN "storage_cursor" text;--> statement-breakpoint
ALTER TABLE "storage_binding" ADD CONSTRAINT "storage_binding_connection_id_account_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."account_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_binding" ADD CONSTRAINT "storage_binding_target_entity_id_entity_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_binding" ADD CONSTRAINT "storage_binding_bound_by_user_id_fk" FOREIGN KEY ("bound_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_binding_provider_folder_unique" ON "storage_binding" USING btree ("provider","folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_binding_mirror_root_unique" ON "storage_binding" USING btree ("is_mirror_root") WHERE "storage_binding"."is_mirror_root";--> statement-breakpoint
CREATE INDEX "storage_binding_target_idx" ON "storage_binding" USING btree ("target_entity_id");--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_binding_id_storage_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."storage_binding"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_binding_idx" ON "document" USING btree ("binding_id");