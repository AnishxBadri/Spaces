-- A person's name in two parts, and phone as a multi-valued E.164 list (D67).
--
-- Hand-written: no column changes. Three data moves:
-- 1. Every person's canonical_name split on its last space into the
--    first_name and last_name values, exactly as splitName does it
--    (whitespace collapsed, trimmed; no space means a first name only).
--    A person already holding either part is left alone.
-- 2. The system phone attribute on people gains options.multi.
-- 3. A person's phone string becomes a list of one, in E.164 when it reads
--    as `+` then 2–15 digits, otherwise as written.
-- The first_name/last_name attribute rows are the boot seed's, not this file's.

WITH named AS (
  SELECT id, regexp_replace(btrim(canonical_name), '\s+', ' ', 'g') AS n
  FROM entity
  WHERE kind = 'person'
)
UPDATE entity e
SET values = e.values || jsonb_strip_nulls(jsonb_build_object(
  'first_name',
  CASE WHEN position(' ' in named.n) = 0 THEN named.n
       ELSE left(named.n, length(named.n) - position(' ' in reverse(named.n)))
  END,
  'last_name',
  CASE WHEN position(' ' in named.n) = 0 THEN NULL
       ELSE right(named.n, position(' ' in reverse(named.n)) - 1)
  END
))
FROM named
WHERE e.id = named.id
  AND named.n <> ''
  AND NOT (e.values ? 'first_name')
  AND NOT (e.values ? 'last_name');
--> statement-breakpoint

UPDATE attribute a
SET options = a.options || '{"multi": true}'::jsonb
FROM object o
WHERE a.object_id = o.id
  AND o.slug = 'people'
  AND o.is_system
  AND a.slug = 'phone'
  AND a.type = 'phone'
  AND a.is_system
  AND NOT (a.options ? 'multi');
--> statement-breakpoint

WITH phones AS (
  SELECT id, btrim(values ->> 'phone') AS p
  FROM entity
  WHERE kind = 'person' AND jsonb_typeof(values -> 'phone') = 'string'
)
UPDATE entity e
SET values = jsonb_set(e.values, '{phone}', jsonb_build_array(
  CASE WHEN phones.p ~ '^\+[0-9[:space:]().\-/]+$'
        AND length(regexp_replace(phones.p, '\D', '', 'g')) BETWEEN 2 AND 15
       THEN '+' || regexp_replace(phones.p, '\D', '', 'g')
       ELSE phones.p
  END
))
FROM phones
WHERE e.id = phones.id
  AND phones.p <> ''
  AND EXISTS (
    SELECT 1 FROM attribute a JOIN object o ON o.id = a.object_id
    WHERE o.slug = 'people' AND o.is_system
      AND a.slug = 'phone' AND a.type = 'phone'
      AND (a.options ->> 'multi')::boolean
  );
