ALTER TABLE "integration" DROP CONSTRAINT "integration_connection_id_account_connection_id_fk";
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "visibility" "visibility" DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "author_id" text;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_connection_id_account_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."account_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: an attachment that only a private mail filing brought in is private to its email body's author (D67).
UPDATE "document" AS d
SET "visibility" = 'private',
    "author_id" = (
      SELECT an.author_id FROM interaction_document ad
      JOIN interaction ai ON ai.id = ad.interaction_id
      JOIN note an ON an.entity_id = ai.note_id
      WHERE ad.document_id = d.entity_id AND ad.role = 'attachment'
      ORDER BY ai.occurred_at, ai.id
      LIMIT 1
    )
WHERE EXISTS (
    SELECT 1 FROM interaction_document ad
    WHERE ad.document_id = d.entity_id AND ad.role = 'attachment'
  )
  AND NOT EXISTS (
    SELECT 1 FROM interaction_document ad
    JOIN interaction ai ON ai.id = ad.interaction_id
    LEFT JOIN note an ON an.entity_id = ai.note_id
    WHERE ad.document_id = d.entity_id AND ad.role = 'attachment'
      AND an.visibility IS DISTINCT FROM 'private'
  )
  AND d.source_ref IN (
    SELECT ai.source_ref FROM interaction_document ad
    JOIN interaction ai ON ai.id = ad.interaction_id
    WHERE ad.document_id = d.entity_id AND ad.role = 'attachment'
      AND ai.source_ref IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM link al
    WHERE al.from_entity_id = d.entity_id AND al.relation = 'tagged_in'
      AND al.created_by IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM entity_space ae
    WHERE ae.entity_id = d.entity_id AND ae.created_by IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM activity aa
    WHERE aa.subject_entity_id = d.entity_id AND aa.verb = 'document.arrived'
      AND (
        aa.actor_id IS NOT NULL
        OR coalesce(aa.meta ->> 'integrationId', '') NOT IN (
          SELECT ai.source_ref::text FROM interaction_document ad
          JOIN interaction ai ON ai.id = ad.interaction_id
          WHERE ad.document_id = d.entity_id AND ad.role = 'attachment'
            AND ai.source_ref IS NOT NULL
        )
      )
  );
