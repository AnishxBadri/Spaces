import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

/**
 * A plugin's own Postgres schema: `plugin_<id>`, hyphens as underscores.
 * The worker's PluginDb creates and migrates it; uninstall's drop-data
 * option drops it.
 */

export const pluginSchemaName = (pluginId: string): string =>
  `plugin_${pluginId.replaceAll('-', '_')}`

/** Drops the schema, its journal and every table in it. Run as the owning user. */
export const dropPluginSchemaStatement = (pluginId: string): SQL =>
  sql`drop schema if exists ${sql.identifier(pluginSchemaName(pluginId))} cascade`
