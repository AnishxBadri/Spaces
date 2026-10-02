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
 * The installed-integration row (CONTEXT.md "Plugin architecture").
 * Capability = code (a manifest id); integration = this row, the host's side
 * of the install: version, on/off, vault material, health. The bytes live in
 * `/data/plugins`.
 * - `source_ref` and `attribute_event.actor_ref` must agree: both name the
 *   integration, not the capability, so two sharing one grant stay distinct.
 * - No FK from here into any `plugin_<id>` schema, ever: a plugin may depend
 *   on core, core never depends on a plugin.
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

/**
 * The plugin's validated `manifest.json`, as the loader last parsed it.
 * - Web renders from this column and never reads `/data/plugins` — what keeps
 *   "web never executes plugin code" true across separate containers.
 * - JSON, not the SDK's `Manifest`: this package imports nothing internal.
 *   The loader writes only what `manifestSchema` accepted; readers decode
 *   with `manifestSchema` again.
 * - Null until first validated; always null for a first-party `core.*` row.
 */
export type IntegrationManifest = { [k: string]: Json }

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
  manifest: jsonb('manifest').$type<IntegrationManifest>(),
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
