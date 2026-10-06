-- One credential per (scope, provider, user_id), workspace rows included.
-- The old unique index counted a workspace row's null user_id as distinct, so
-- duplicates may exist. Collapse them before the constraint is created:
-- - keep the most recently created row of each group (PARTITION BY groups
--   nulls together, which is the grouping the new constraint enforces);
-- - repoint every column that references credential.id at the kept row;
-- - then delete the rest.

WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY scope, provider, user_id ORDER BY created_at DESC, id DESC
  ) AS keep_id
  FROM credential
)
UPDATE mailbox m SET credential_id = r.keep_id
FROM ranked r
WHERE m.credential_id = r.id AND r.id <> r.keep_id;
--> statement-breakpoint

WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY scope, provider, user_id ORDER BY created_at DESC, id DESC
  ) AS keep_id
  FROM credential
)
UPDATE integration i SET credential_id = r.keep_id
FROM ranked r
WHERE i.credential_id = r.id AND r.id <> r.keep_id;
--> statement-breakpoint

WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY scope, provider, user_id ORDER BY created_at DESC, id DESC
  ) AS keep_id
  FROM credential
)
UPDATE ai_run a SET credential_id = r.keep_id
FROM ranked r
WHERE a.credential_id = r.id AND r.id <> r.keep_id;
--> statement-breakpoint

WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY scope, provider, user_id ORDER BY created_at DESC, id DESC
  ) AS keep_id
  FROM credential
)
DELETE FROM credential c
USING ranked r
WHERE c.id = r.id AND r.id <> r.keep_id;
--> statement-breakpoint

DROP INDEX "credential_user_unique";--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_user_unique" UNIQUE NULLS NOT DISTINCT("scope","provider","user_id");
