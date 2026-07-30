-- Search needs two indexes that did not exist yet. Hand-written: drizzle-kit
-- can express neither a generated tsvector column nor an operator class.

-- Notes: a STORED generated column rather than a trigger or app-side write.
-- body_md is already derived on every save, so the search vector can be
-- derived from it too — one less thing that can silently fall out of sync.
-- Title carries weight A over body B: a note called "Cooling" should beat a
-- note that says "cooling" once in passing.
ALTER TABLE note ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body_md, '')), 'B')
  ) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS note_tsv_idx ON note USING gin (tsv);
--> statement-breakpoint

-- The fuzzy-name path. entity_alias already has a trigram index for
-- resolution; canonical_name did not, so every name search was a seq scan
-- with ILIKE. Trigram also buys real typo tolerance — "orbitl" finds
-- Orbital Composites, which ILIKE never will.
CREATE INDEX IF NOT EXISTS entity_name_trgm_idx
  ON entity USING gin (canonical_name gin_trgm_ops);
