import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'
import { accountConnection, credential } from './vault'
import type { Json } from '../json'

/**
 * The installed-integration row (`docs/spec-plugin-sdk.md` §8, CONTEXT.md
 * "Plugin architecture"). Capability = code: what a plugin _can_ do, named by
 * its manifest id and listed in the registry. Integration = row: what this
 * host actually did with it. Nothing about the plugin's code lives here — the
 * bytes are in `/data/plugins`, the manifest is the contract — so the row is
 * exactly the host's side of the install: which capability, at which version,
 * turned on or not, with which vault material, and how it has been behaving.
 *
 * Two consumers point at this row and must agree: `source_ref` (the enum
 * collapse, still ahead) and `attribute_event.actor_ref` (here, now). Both
 * name the integration, not the capability, so two integrations sharing one
 * Google grant stay distinguishable and "which integration wrote this" has a
 * single enforceable answer.
 *
 * No FK from here into any `plugin_<id>` schema, ever: a plugin may depend on
 * core, core never depends on a plugin (spec §8).
 */

/**
 * `installing` is the birth state — the installer has a row before it has
 * bytes — and is therefore the default; `degraded` is the loader's word for
 * "running but erroring", distinct from an operator's `disabled`.
 */
export const integrationStatus = pgEnum('integration_status', [
  'installing',
  'enabled',
  'degraded',
  'disabled',
])

/**
 * Manifest-typed plugin config, read through the SDK's `Config` port. Open at
 * the column because the manifest, not this schema, knows each plugin's
 * shape — the same bargain `credential.meta` makes.
 */
export type IntegrationConfig = { [k: string]: Json }

export const integration = pgTable('integration', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** `manifest.id` — the capability this row installs. */
  capabilityId: text('capability_id').notNull(),
  /** The installed version, not the range the registry offers. */
  version: text('version').notNull(),
  /**
   * The operator's switch, separate from `status`: a row can be enabled and
   * degraded at once, which is precisely the state the settings UI must show.
   * Born off — an install that has not been configured must not run.
   */
  enabled: boolean('enabled').notNull().default(false),
  status: integrationStatus('status').notNull().default('installing'),
  config: jsonb('config').$type<IntegrationConfig>().notNull().default({}),
  /** BYOK key (an Apollo token); null for a plugin that needs none. */
  credentialId: uuid('credential_id').references(() => credential.id),
  /** OAuth grant (a Gmail mailbox); null for a plugin that needs none. */
  connectionId: uuid('connection_id').references(() => accountConnection.id),
  errorCount: integer('error_count').notNull().default(0),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastError: text('last_error'),
  /** The admin who installed it; null for a row the seed or an import made. */
  createdBy: text('created_by').references(() => user.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
