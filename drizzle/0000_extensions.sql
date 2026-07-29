-- Extensions required by the schema. Must run before any table using
-- vector/ltree types. All four ship with the pgvector/pgvector image.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS unaccent;
