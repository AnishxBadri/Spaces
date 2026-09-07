-- Hand-written (SPA-9): give deal.owner its `current-user` default on
-- deployments that already have the attribute. The boot seed is
-- insert-if-absent and never rewrites an existing row (options are user
-- content after first boot), so a default added to a system attribute in a
-- release arrives by migration. Only fills when no default is set, so an
-- operator's own choice survives.
UPDATE "attribute" a
SET "options" = a."options" || '{"default":"current-user"}'::jsonb
FROM "object" o
WHERE o."id" = a."object_id"
  AND o."slug" = 'deals'
  AND a."slug" = 'owner'
  AND a."is_system"
  AND NOT (a."options" ? 'default');
