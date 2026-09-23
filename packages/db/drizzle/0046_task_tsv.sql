-- Tasks join Cmd-K as a fourth RRF lane over task.content (SPA-55, CONTEXT.md
-- 15b re-examined 2026-09-14). Hand-written over drizzle-kit's body for the
-- reason 0009 was: drizzle-kit can express neither a generated tsvector
-- column nor a GIN index on one.

-- A STORED generated column, like note.tsv, not a trigger or an app-side
-- write: content is the whole of what a task says, so the vector derives
-- from it and cannot drift. Adding it rewrites the table, so every existing
-- task is searchable the moment this lands. One field, so no weights.
ALTER TABLE task ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS task_tsv_idx ON task USING gin (tsv);
