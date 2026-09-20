-- Documents file into spaces through entity_space, not through link
-- (spec-storage-sources §11 delta 4; CONTEXT.md → Sources are documents).
-- The doctrine already said so — "a document filed into a space is a
-- source" — but `finalizeDocumentUpload` took one uuid and wrote
-- link(tagged_in) whatever it pointed at, so a space could be reached as a
-- link target. Migration 0008 did exactly this for notes; a document filed
-- into a space by that path is the same stray row, and the space page reads
-- entity_space, so it was already invisible there.
--
-- Hand-written rather than drizzle-generated: no column changes. This moves
-- data, and an existing filed document going invisible is the one outcome
-- that is not acceptable, so the INSERT lands before the DELETE and both
-- run under one migration's breakpointed pair.

INSERT INTO entity_space (entity_id, space_id, source, created_by, created_at)
SELECT l.from_entity_id, l.to_entity_id, 'manual', l.created_by, l.created_at
FROM link l
JOIN entity src ON src.id = l.from_entity_id AND src.kind = 'document'
JOIN entity dst ON dst.id = l.to_entity_id AND dst.kind = 'space'
WHERE l.relation = 'tagged_in'
ON CONFLICT (entity_id, space_id) DO NOTHING;
--> statement-breakpoint

DELETE FROM link l
USING entity src, entity dst
WHERE src.id = l.from_entity_id AND src.kind = 'document'
  AND dst.id = l.to_entity_id AND dst.kind = 'space'
  AND l.relation = 'tagged_in';
