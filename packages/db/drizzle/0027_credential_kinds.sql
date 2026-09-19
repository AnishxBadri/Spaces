-- SPA-112 (clean-2c). credential_kind opens from three values to six. Nothing
-- in this release writes the three new ones; they exist so the slices that
-- need them do not each widen the enum in their own migration lane:
--   embedding    — the AI substrate's embedding providers, a different
--                  credential class from chat models because the pinned
--                  dimension makes them non-interchangeable
--                  (docs/spec-ai-substrate.md §9).
--   oauth_client — an OAuth app's client id and secret per provider,
--                  registered once by the operator (slice storage-1,
--                  docs/spec-plugin-sdk.md §12).
--   webhook      — a webhook signing secret per integration (slice sdk-23).
-- Additive by construction: Postgres ADD VALUE leaves every existing row's
-- kind alone, and the vault's AAD is `scope:provider`, so kind is not an
-- encryption input and no stored ciphertext is touched.
ALTER TYPE "public"."credential_kind" ADD VALUE 'embedding' BEFORE 'enrichment';--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE 'oauth_client';--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE 'webhook';
