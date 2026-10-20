import type { IntegrationManifest } from '@spaces/db/schema'
import { jsonString } from '../json'

/**
 * An integration's display name: its manifest's `name` once the loader has
 * validated the plugin, else its capability id (a first-party `core.*` row
 * has no manifest).
 */
export const integrationName = (row: {
  capabilityId: string
  manifest: IntegrationManifest | null
}): string => jsonString(row.manifest?.name) ?? row.capabilityId
