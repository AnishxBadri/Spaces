-- Space membership goes through entity_space for every kind, not just
-- companies. Memos were the one exception: createNote wrote a
-- link(note -> space, tagged_in) row, which left "what is in this space" a
-- two-table question and denied notes the source/confidence provenance that
-- entity_space carries for AI-suggested tagging.
--
-- Move them, then drop them. Hand-written rather than drizzle-generated:
-- this is a data migration, and an existing memo going invisible is the one
-- outcome that is not acceptable.

INSERT INTO entity_space (entity_id, space_id, source, created_by, created_at)
SELECT l.from_entity_id, l.to_entity_id, 'manual', l.created_by, l.created_at
FROM link l
JOIN entity src ON src.id = l.from_entity_id AND src.kind = 'note'
JOIN entity dst ON dst.id = l.to_entity_id AND dst.kind = 'space'
WHERE l.relation = 'tagged_in'
ON CONFLICT (entity_id, space_id) DO NOTHING;
--> statement-breakpoint

DELETE FROM link l
USING entity src, entity dst
WHERE src.id = l.from_entity_id AND src.kind = 'note'
  AND dst.id = l.to_entity_id AND dst.kind = 'space'
  AND l.relation = 'tagged_in';
