-- LinkedIn on a person or a company is identity: an `entity_alias`, never an
-- attribute. Every `values.linkedin` becomes a `linkedin` identity alias, the
-- key leaves `entity.values`, and the two system `linkedin` attributes are
-- archived. The reconciler drops any `attr_idx_*` minted for them at boot.
--
-- Hand-written: no column changes, only data.
--
-- - `migrate_normalize_linkedin` is `normalizeLinkedin` spelt in SQL (trim,
--   lowercase, the same pattern, percent-decoding). Where the TS normalizer
--   throws on a malformed escape, or yields a value Postgres cannot store,
--   this answers null. A test holds the two equal over sample URLs.
-- - An unnormalizable value, or one another record already holds, gets no
--   alias and is named in a WARNING. Every removed value keeps an
--   `attribute_event` row, so nothing is lost from history.
-- - Merged-away records lose the key but get no alias: their aliases already
--   moved to the winner.
-- - Custom objects that declared `linkedin` as an identity key are untouched.

CREATE OR REPLACE FUNCTION migrate_normalize_linkedin(input text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  m text[];
  slug text;
  bytes bytea := '\x';
  i int := 1;
BEGIN
  m := regexp_match(
    lower(regexp_replace(
      input,
      '[\t\n\v\f\r    -     　﻿]+$',
      ''
    )),
    'linkedin\.com/(in|company|school)/([a-z0-9_%.-]+?)/?(?:[?#][^\n\r  ]*)?$'
  );
  IF m IS NULL THEN RETURN NULL; END IF;
  slug := m[2];
  WHILE i <= length(slug) LOOP
    IF substr(slug, i, 1) = '%' THEN
      IF substr(slug, i + 1, 2) !~ '^[0-9a-f]{2}$' THEN RETURN NULL; END IF;
      bytes := bytes || decode(substr(slug, i + 1, 2), 'hex');
      i := i + 3;
    ELSE
      bytes := bytes || convert_to(substr(slug, i, 1), 'UTF8');
      i := i + 1;
    END IF;
  END LOOP;
  RETURN 'linkedin.com/' || m[1] || '/' || convert_from(bytes, 'UTF8');
EXCEPTION WHEN others THEN
  -- Invalid UTF-8 or a NUL byte: no alias can hold it.
  RETURN NULL;
END
$fn$;
--> statement-breakpoint

DO $warn$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH claims AS (
      SELECT e.id, e.kind, e.created_at, e."values" ->> 'linkedin' AS raw,
             migrate_normalize_linkedin(e."values" ->> 'linkedin') AS norm
      FROM entity e
      WHERE e.kind IN ('person', 'company')
        AND e.merged_into_id IS NULL
        AND jsonb_typeof(e."values" -> 'linkedin') = 'string'
        AND btrim(e."values" ->> 'linkedin') <> ''
    )
    SELECT c.*,
           EXISTS (
             SELECT 1 FROM entity_alias a
             WHERE a.kind = 'linkedin' AND a.is_identity
               AND a.value_norm = c.norm AND a.entity_id <> c.id
           ) OR EXISTS (
             SELECT 1 FROM claims o
             WHERE o.norm = c.norm AND (o.created_at, o.id) < (c.created_at, c.id)
           ) AS held
    FROM claims c
  LOOP
    IF r.norm IS NULL THEN
      RAISE WARNING 'linkedin: % % value % is not a LinkedIn URL; dropped, kept in attribute_event',
        r.kind, r.id, r.raw;
    ELSIF r.held THEN
      RAISE WARNING 'linkedin: % % value % is already another record''s identity; no alias added',
        r.kind, r.id, r.norm;
    END IF;
  END LOOP;
END
$warn$;
--> statement-breakpoint

INSERT INTO attribute_event (entity_id, attr_slug, "from", "to", actor_type, source)
SELECT e.id, 'linkedin', e."values" -> 'linkedin', NULL, 'system', 'seed'
FROM entity e
WHERE e.kind IN ('person', 'company')
  AND e."values" ? 'linkedin'
  AND jsonb_typeof(e."values" -> 'linkedin') <> 'null';
--> statement-breakpoint

INSERT INTO entity_alias (entity_id, kind, value, value_norm, is_identity, source_class)
SELECT c.id, 'linkedin', c.value, c.norm, true, 'seed'
FROM (
  SELECT e.id, e.created_at,
         regexp_replace(
           e."values" ->> 'linkedin',
           '^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$',
           '', 'g'
         ) AS value,
         migrate_normalize_linkedin(e."values" ->> 'linkedin') AS norm
  FROM entity e
  WHERE e.kind IN ('person', 'company')
    AND e.merged_into_id IS NULL
    AND jsonb_typeof(e."values" -> 'linkedin') = 'string'
) c
WHERE c.norm IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM entity_alias a
    WHERE a.entity_id = c.id AND a.kind = 'linkedin' AND a.value_norm = c.norm
  )
ORDER BY c.created_at, c.id
ON CONFLICT DO NOTHING;
--> statement-breakpoint

UPDATE entity
SET "values" = "values" - 'linkedin'
WHERE kind IN ('person', 'company') AND "values" ? 'linkedin';
--> statement-breakpoint

UPDATE attribute
SET archived = true
WHERE slug = 'linkedin'
  AND object_id IN (
    SELECT id FROM "object" WHERE is_system AND slug IN ('people', 'companies')
  );
--> statement-breakpoint

DROP FUNCTION migrate_normalize_linkedin(text);
