-- `organization` deleted outright (CONTEXT.md "Two-tier object model",
-- roadmap clean-1): no object registry row, no create path, no page — a
-- ghost kind that `recordPath` nonetheless routed to /companies/:id. A user
-- models co-investors as Companies or as a custom object, their call.
--
-- Postgres cannot drop a value from an enum in place, so this follows the
-- 0010_drop_thesis precedent: cast to text, drop the type, recreate it
-- without the value, cast back. 0010 *deleted* its rows first; here a
-- surviving row means something wrote a kind the product does not have, so
-- the guard raises and the whole migration rolls back instead. `entity.kind`
-- carries no DEFAULT, so there is no drop-default dance.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "entity" WHERE "kind" = 'organization') THEN
    RAISE EXCEPTION 'entity rows still carry kind = ''organization''; convert them (Companies, or a custom object) before dropping the enum value';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "entity" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."entity_kind";--> statement-breakpoint
CREATE TYPE "public"."entity_kind" AS ENUM('company', 'person', 'deal', 'space', 'note', 'document', 'term', 'custom');--> statement-breakpoint
ALTER TABLE "entity" ALTER COLUMN "kind" SET DATA TYPE "public"."entity_kind" USING "kind"::"public"."entity_kind";
