-- document gains its storage-source provenance (SPA-78,
-- docs/spec-storage-sources.md §11 delta 1). Five columns and one partial
-- unique index; no data change — every existing row keeps five nulls.
--
-- source_path      the provider's own path, kept verbatim (§5.3) so a row can
--                  read "from Data room / Legal" and write-through can put the
--                  file back where it came from. A label, never a key:
--                  retrieval scopes by entity_space and ltree.
-- external_id      the provider's id for the file.
-- external_url     the provider's link — "Open in source" on the row.
-- external_status  linked | gone (§8). Deleted in Drive means `gone` on our
--                  row, not a delete of our row: copy-in (§7) is what makes
--                  their retention policy not ours.
-- connection_id    whose account it came through.
--
-- The partial unique index on (connection_id, external_id) is the reason this
-- ships with the columns rather than with the first plugin: §6's loop
-- prevention ("our own export seen by the poll → external_id match → no-op")
-- and §8's cursor-expiry full re-list are both `on conflict` on that pair, and
-- neither is idempotent without it. Partial because the pair is null on every
-- hand-uploaded row, and a plain unique index would admit exactly one of them.
--
-- NO `ENTITY_REFS` ENTRY, deliberately. The next reader will assume there is
-- one, because CLAUDE.md says a new column referencing an entity needs one.
-- This column does not reference an entity: its FK target is
-- `account_connection.id`, a plain uuid primary key on a non-entity table —
-- not `entity.id`, and not a side table's `entity_id`. The membership rule in
-- `packages/db/src/entity-refs.ts` is exactly that, and `entity-refs.test.ts`
-- derives the same set from drizzle's FK metadata, so an entry here would fail
-- as stale rather than pass as caution. Merging two entities never repoints a
-- connection, and deleting one never touches this column.

CREATE TYPE "public"."external_status" AS ENUM('linked', 'gone');--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "source_path" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "external_url" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "external_status" "external_status";--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_connection_id_account_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."account_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_connection_external_unique" ON "document" USING btree ("connection_id","external_id") WHERE "document"."connection_id" is not null and "document"."external_id" is not null;