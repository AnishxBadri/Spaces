-- Indexes drizzle-kit can't express (operator classes / index methods).

-- Fuzzy name matching for entity resolution (pg_trgm).
CREATE INDEX IF NOT EXISTS alias_name_trgm_idx
  ON entity_alias USING gin (value_norm gin_trgm_ops)
  WHERE kind = 'name';

-- Space taxonomy ancestor/descendant queries.
CREATE INDEX IF NOT EXISTS space_path_gist_idx
  ON space USING gist (path);

-- Semantic search over document chunks. HNSW: no training-set requirement,
-- fine at this scale.
CREATE INDEX IF NOT EXISTS chunk_embedding_hnsw_idx
  ON document_chunk USING hnsw (embedding vector_cosine_ops);

-- Full-text search over extracted document text.
CREATE INDEX IF NOT EXISTS document_tsv_idx
  ON document USING gin (tsv);
