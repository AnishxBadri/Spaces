-- A person's companies become the `companies` attribute (D60). Every
-- `link(contact_at)` is converted; afterwards nothing writes `contact_at`.
-- The enum value stays: Postgres cannot drop one without rebuilding the type.
--
-- Hand-written: no column changes, only data. Runs before the boot seed, so
-- the values land before the `companies` attribute row is seeded beside them.
--
-- - person → company: the person's `values.companies` becomes exactly its
--   former targets (in link order), with one `attribute_event` as history,
--   and each link row is rewritten in place to `references` / 'companies' —
--   what `setValues` would have materialized. No unique-index collision is
--   possible: no 'companies' reference rows exist before this migration.
-- - person → deal: only an identity accept wrote these. The person joins the
--   deal's `people` unless that or `referred_by` already holds them, with the
--   matching `references` link.
-- - anything left (a person contact at a custom record) is deleted: since
--   identities name their field, the record's own reference holds the person.

WITH targets AS (
  SELECT l.from_entity_id AS person_id,
         jsonb_agg(to_jsonb(l.to_entity_id::text) ORDER BY l.created_at, l.id) AS ids
  FROM link l
  JOIN entity p ON p.id = l.from_entity_id AND p.kind = 'person'
  JOIN entity c ON c.id = l.to_entity_id AND c.kind = 'company'
  WHERE l.relation = 'contact_at'
  GROUP BY l.from_entity_id
),
history AS (
  INSERT INTO attribute_event (entity_id, attr_slug, "from", "to", actor_type, source)
  SELECT t.person_id, 'companies', e."values" -> 'companies', t.ids, 'system', 'seed'
  FROM targets t
  JOIN entity e ON e.id = t.person_id
)
UPDATE entity e
SET "values" = e."values" || jsonb_build_object('companies', t.ids)
FROM targets t
WHERE e.id = t.person_id;
--> statement-breakpoint

UPDATE link l
SET relation = 'references', attr_slug = 'companies'
FROM entity p, entity c
WHERE p.id = l.from_entity_id AND p.kind = 'person'
  AND c.id = l.to_entity_id AND c.kind = 'company'
  AND l.relation = 'contact_at';
--> statement-breakpoint

WITH added AS (
  SELECT d.id AS deal_id,
         jsonb_agg(to_jsonb(l.from_entity_id::text) ORDER BY l.created_at, l.id) AS ids
  FROM link l
  JOIN entity p ON p.id = l.from_entity_id AND p.kind = 'person'
  JOIN entity d ON d.id = l.to_entity_id AND d.kind = 'deal'
  WHERE l.relation = 'contact_at'
    AND NOT (
      CASE WHEN jsonb_typeof(d."values" -> 'people') = 'array'
           THEN d."values" -> 'people' ELSE '[]'::jsonb END
      @> jsonb_build_array(l.from_entity_id::text)
    )
    AND (d."values" ->> 'referred_by') IS DISTINCT FROM l.from_entity_id::text
  GROUP BY d.id
),
history AS (
  INSERT INTO attribute_event (entity_id, attr_slug, "from", "to", actor_type, source)
  SELECT a.deal_id, 'people', d."values" -> 'people',
         (CASE WHEN jsonb_typeof(d."values" -> 'people') = 'array'
               THEN d."values" -> 'people' ELSE '[]'::jsonb END) || a.ids,
         'system', 'seed'
  FROM added a
  JOIN entity d ON d.id = a.deal_id
)
UPDATE entity d
SET "values" = d."values" || jsonb_build_object(
  'people',
  (CASE WHEN jsonb_typeof(d."values" -> 'people') = 'array'
        THEN d."values" -> 'people' ELSE '[]'::jsonb END) || a.ids
)
FROM added a
WHERE d.id = a.deal_id;
--> statement-breakpoint

INSERT INTO link (from_entity_id, to_entity_id, relation, attr_slug, source, created_by, created_at)
SELECT l.to_entity_id, l.from_entity_id, 'references', 'people', l.source, l.created_by, l.created_at
FROM link l
JOIN entity p ON p.id = l.from_entity_id AND p.kind = 'person'
JOIN entity d ON d.id = l.to_entity_id AND d.kind = 'deal'
WHERE l.relation = 'contact_at'
  AND jsonb_typeof(d."values" -> 'people') = 'array'
  AND d."values" -> 'people' @> jsonb_build_array(l.from_entity_id::text)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DELETE FROM link WHERE relation = 'contact_at';
