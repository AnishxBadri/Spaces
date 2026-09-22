ALTER TABLE "attribute" ADD COLUMN "filterable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute" ADD COLUMN "sortable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The two coercions the view compiler (apps/web/src/lib/views/sql.ts) puts
-- around every `values -> 'slug'` read, lifted out of the query and into the
-- database so they can be indexed (SPA-93).
--
-- They were inline CASE expressions. `String(v)`'s array branch needs
-- `jsonb_array_elements`, which is a subquery, and Postgres refuses a
-- subquery in an index expression — so no per-attribute index could ever
-- match what the query actually emitted. As IMMUTABLE functions the same
-- expressions are one node the planner can match, which is what lets
-- `reconcileValueIndexes()` mint `attr_idx_<attribute id>` on
-- `entity (object_id, spaces_json_text(values -> '<slug>'))` and have the
-- paged list's ORDER BY use it.
--
-- The bodies are transcriptions of `text()` and `num()` in `sql.ts`, which
-- is where the reasoning for each branch lives; `sql.test.ts` walks every op
-- against every type and is what holds the two evaluators to the same
-- answers.
--
-- Two shapes here are load-bearing and look like clumsiness:
--
--   * `spaces_json_number` spells the text coercion out again instead of
--     calling `spaces_json_text`. A `CREATE INDEX` evaluates its expression
--     under a restricted `search_path` (`pg_catalog, pg_temp`), so a body
--     that resolves a non-`pg_catalog` function name at execution time fails
--     the index build with "function spaces_json_text(jsonb) does not
--     exist". Everything either body calls is in `pg_catalog`.
--   * that copy sits in a `FROM (SELECT ...) AS t(v)`, which computes it
--     once for the three branches that read it, and — because a SQL function
--     whose body has a FROM list is never inlined — keeps the call one node
--     the planner can match against an index expression.
CREATE OR REPLACE FUNCTION spaces_json_text(j jsonb) RETURNS text AS $$
  SELECT CASE
    WHEN j IS NULL THEN NULL
    WHEN jsonb_typeof(j) = 'null' THEN 'null'
    WHEN jsonb_typeof(j) = 'array' THEN (
      SELECT coalesce(
        string_agg(
          CASE WHEN jsonb_typeof(e.value) = 'null' THEN '' ELSE e.value #>> '{}' END,
          ',' ORDER BY e.ord),
        '')
      FROM jsonb_array_elements(j) WITH ORDINALITY AS e(value, ord))
    ELSE j #>> '{}'
  END
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION spaces_json_number(j jsonb) RETURNS numeric AS $$
  SELECT CASE
    WHEN j IS NULL THEN NULL
    WHEN jsonb_typeof(j) = 'null' THEN 0
    WHEN jsonb_typeof(j) = 'boolean' THEN (CASE WHEN j = 'true'::jsonb THEN 1 ELSE 0 END)
    WHEN t.v = '' THEN 0
    WHEN t.v ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' THEN t.v::numeric
    ELSE NULL
  END
  FROM (SELECT btrim(CASE
      WHEN j IS NULL THEN NULL
      WHEN jsonb_typeof(j) = 'null' THEN 'null'
      WHEN jsonb_typeof(j) = 'array' THEN (
        SELECT coalesce(
          string_agg(
            CASE WHEN jsonb_typeof(e.value) = 'null' THEN '' ELSE e.value #>> '{}' END,
            ',' ORDER BY e.ord),
          '')
        FROM jsonb_array_elements(j) WITH ORDINALITY AS e(value, ord))
      ELSE j #>> '{}'
    END)) AS t(v)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;
