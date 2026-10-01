import type { integration } from '@spaces/db/schema'
import { redact } from '../vault/crypto'

/**
 * The integration row a plugin's ports are bound to (sdk-6a; spec §4). The
 * loader builds one Layer per (integration, job) from it (sdk-12b): every
 * port here takes the row, so provenance, credentials and config come from
 * the binding and never from the plugin's arguments.
 */
export type BoundIntegration = Pick<
  typeof integration.$inferSelect,
  'id' | 'capabilityId' | 'config' | 'credentialId'
>

/**
 * Replace every occurrence of a secret with the vault's display form
 * (`redact()`: `sk-…1234`), so a key a plugin logs, or a URL carrying one
 * that ends up in an error, never reaches a log line or `last_error` whole.
 * Built from the secrets the binding resolved; a binding with none returns
 * text untouched.
 */
export type Scrub = (text: string) => string

export const makeScrub = (secrets: ReadonlyArray<string>): Scrub => {
  // Longest first, so a secret that contains another is replaced whole.
  const ordered = [...secrets]
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length)
  return (text) =>
    ordered.reduce(
      (out, secret) => out.replaceAll(secret, redact(secret)),
      text,
    )
}

export const noScrub: Scrub = (text) => text
