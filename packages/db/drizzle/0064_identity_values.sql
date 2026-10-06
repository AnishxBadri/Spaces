-- Identity is a unique attribute (D75). A person's emails and a company's
-- domains move into `entity.values` (`emails` / `domains`, arrays in alias
-- order); `entity_alias` stays as their index. LinkedIn on people and
-- companies goes back to the plain `linkedin` attribute, and `cin` leaves
-- the `alias_kind` enum.
--
-- - Live records only: a merged-away record's aliases already moved.
-- - Every value written here logs one system `attribute_event`.
-- - A domain alias on a person or an email alias on a company is no
--   attribute's value; it is left as it is and named in a WARNING.
-- - LinkedIn keeps the oldest alias; a URL with no scheme gains `https://`
--   so the `url` validator accepts it. Any other alias is named in a WARNING.
-- - The `emails` / `domains` attribute rows come from the boot seed.

DO $warn$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT e.kind, a.entity_id, a.kind AS key, a.value_norm
    FROM entity_alias a
    JOIN entity e ON e.id = a.entity_id
    WHERE a.is_identity
      AND ((e.kind = 'person' AND a.kind = 'domain')
        OR (e.kind = 'company' AND a.kind = 'email'))
  LOOP
    RAISE WARNING 'identity: % % holds % alias %, which no attribute carries; left as it is',
      r.kind, r.entity_id, r.key, r.value_norm;
  END LOOP;
  FOR r IN
    SELECT e.kind, a.entity_id, a.value_norm
    FROM (
      SELECT a.*, row_number() OVER (
        PARTITION BY a.entity_id ORDER BY a.created_at, a.id
      ) AS n
      FROM entity_alias a
      WHERE a.kind = 'linkedin'
    ) a
    JOIN entity e ON e.id = a.entity_id
    WHERE e.kind IN ('person', 'company') AND a.n > 1
  LOOP
    RAISE WARNING 'linkedin: % % also held %; only the oldest LinkedIn is kept',
      r.kind, r.entity_id, r.value_norm;
  END LOOP;
END
$warn$;
--> statement-breakpoint

WITH held AS (
  SELECT e.id,
         e."values" -> 'emails' AS before,
         jsonb_agg(
           coalesce(nullif(btrim(a.value), ''), a.value_norm)
           ORDER BY a.created_at, a.id
         ) AS after
  FROM entity e
  JOIN entity_alias a
    ON a.entity_id = e.id AND a.kind = 'email' AND a.is_identity
  WHERE e.kind = 'person' AND e.merged_into_id IS NULL
  GROUP BY e.id
), changed AS (
  SELECT * FROM held WHERE before IS DISTINCT FROM after
), logged AS (
  INSERT INTO attribute_event (entity_id, attr_slug, "from", "to", actor_type, source)
  SELECT id, 'emails', before, after, 'system', 'seed' FROM changed
)
UPDATE entity e
SET "values" = e."values" || jsonb_build_object('emails', c.after)
FROM changed c
WHERE e.id = c.id;
--> statement-breakpoint

WITH held AS (
  SELECT e.id,
         e."values" -> 'domains' AS before,
         jsonb_agg(
           coalesce(nullif(btrim(a.value), ''), a.value_norm)
           ORDER BY a.created_at, a.id
         ) AS after
  FROM entity e
  JOIN entity_alias a
    ON a.entity_id = e.id AND a.kind = 'domain' AND a.is_identity
  WHERE e.kind = 'company' AND e.merged_into_id IS NULL
  GROUP BY e.id
), changed AS (
  SELECT * FROM held WHERE before IS DISTINCT FROM after
), logged AS (
  INSERT INTO attribute_event (entity_id, attr_slug, "from", "to", actor_type, source)
  SELECT id, 'domains', before, after, 'system', 'seed' FROM changed
)
UPDATE entity e
SET "values" = e."values" || jsonb_build_object('domains', c.after)
FROM changed c
WHERE e.id = c.id;
--> statement-breakpoint

WITH oldest AS (
  SELECT DISTINCT ON (a.entity_id)
         a.entity_id AS id,
         coalesce(nullif(btrim(a.value), ''), a.value_norm) AS raw
  FROM entity_alias a
  JOIN entity e ON e.id = a.entity_id
  WHERE a.kind = 'linkedin' AND e.kind IN ('person', 'company')
  ORDER BY a.entity_id, a.created_at, a.id
), urls AS (
  SELECT o.id,
         e."values" -> 'linkedin' AS before,
         CASE WHEN o.raw ~* '^[a-z][a-z0-9+.-]*://' THEN o.raw
              ELSE 'https://' || o.raw END AS url
  FROM oldest o
  JOIN entity e ON e.id = o.id
  WHERE e."values" -> 'linkedin' IS NULL
     OR jsonb_typeof(e."values" -> 'linkedin') = 'null'
), logged AS (
  INSERT INTO attribute_event (entity_id, attr_slug, "from", "to", actor_type, source)
  SELECT id, 'linkedin', before, to_jsonb(url), 'system', 'seed' FROM urls
)
UPDATE entity e
SET "values" = e."values" || jsonb_build_object('linkedin', u.url)
FROM urls u
WHERE e.id = u.id;
--> statement-breakpoint

DELETE FROM entity_alias a
USING entity e
WHERE e.id = a.entity_id
  AND a.kind = 'linkedin'
  AND e.kind IN ('person', 'company');
--> statement-breakpoint

UPDATE attribute
SET archived = false
WHERE slug = 'linkedin'
  AND archived
  AND object_id IN (
    SELECT id FROM "object" WHERE is_system AND slug IN ('people', 'companies')
  );
--> statement-breakpoint

DELETE FROM entity_alias WHERE kind::text = 'cin';
--> statement-breakpoint

-- The fuzzy-name index's predicate compares `kind` to the old type, which
-- blocks the column change; it is dropped and rebuilt as 0002 made it.
DROP INDEX IF EXISTS alias_name_trgm_idx;--> statement-breakpoint
ALTER TABLE "entity_alias" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."alias_kind";--> statement-breakpoint
CREATE TYPE "public"."alias_kind" AS ENUM('name', 'domain', 'email', 'linkedin');--> statement-breakpoint
ALTER TABLE "entity_alias" ALTER COLUMN "kind" SET DATA TYPE "public"."alias_kind" USING "kind"::"public"."alias_kind";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS alias_name_trgm_idx
  ON entity_alias USING gin (value_norm gin_trgm_ops)
  WHERE kind = 'name';
