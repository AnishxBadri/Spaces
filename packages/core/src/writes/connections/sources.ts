import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Effect, Option, Schema } from 'effect'
import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import type { IntegrationConfig } from '@spaces/db/schema'
import { dataDir } from '../vault/key'

/**
 * Which installed plugin is a provider's storage source, and the provider's
 * own link for a file id.
 * - The plugin is found by what its manifest on disk declares — `provides:
 *   'storage-source'` and a connection to the provider — never by its id, so
 *   core names no vendor plugin.
 * - Disabled, removed and tripped rows are never answered.
 */

export type StorageSourceIntegration = {
  readonly integrationId: string
  readonly pluginId: string
}

export class StorageSourceLookupFailed extends Schema.TaggedError<StorageSourceLookupFailed>()(
  'StorageSourceLookupFailed',
  { cause: Schema.Defect() },
) {}

/** The two manifest fields this lookup reads; the loader validated the rest. */
const ManifestClaim = Schema.Struct({
  provides: Schema.optional(Schema.String),
  requires: Schema.optional(
    Schema.Struct({
      connection: Schema.optional(Schema.Struct({ provider: Schema.String })),
    }),
  ),
})

const decodeClaim = Schema.decodeUnknownOption(
  Schema.fromJsonString(ManifestClaim),
)

/** True when `<pluginsRoot>/<id>/current/manifest.json` says storage source for `provider`. */
const claimsProvider = (
  pluginsRoot: string,
  pluginId: string,
  provider: string,
) =>
  Effect.promise(() =>
    readFile(
      path.join(
        pluginsRoot,
        path.basename(pluginId),
        'current',
        'manifest.json',
      ),
      'utf8',
    ).catch(() => null),
  ).pipe(
    Effect.map((text) =>
      text === null
        ? false
        : Option.match(decodeClaim(text), {
            onNone: () => false,
            onSome: (claim) =>
              claim.provides === 'storage-source' &&
              claim.requires?.connection?.provider === provider,
          }),
    ),
  )

/** The enabled storage-source integration for `provider`, oldest first; null when none is installed. */
export const storageSourceIntegrationFor = Effect.fn(
  'storageSourceIntegrationFor',
)(function* (
  provider: string,
  options: { readonly pluginsRoot?: string } = {},
): Effect.fn.Return<
  StorageSourceIntegration | null,
  StorageSourceLookupFailed
> {
  const pluginsRoot = options.pluginsRoot ?? path.join(dataDir(), 'plugins')
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({ id: integration.id, pluginId: integration.capabilityId })
        .from(integration)
        .where(
          and(
            eq(integration.enabled, true),
            isNull(integration.removedAt),
            ne(integration.status, 'disabled'),
          ),
        )
        .orderBy(asc(integration.createdAt)),
    catch: (cause) => new StorageSourceLookupFailed({ cause }),
  })
  for (const row of rows) {
    if (yield* claimsProvider(pluginsRoot, row.pluginId, provider))
      return { integrationId: row.id, pluginId: row.pluginId }
  }
  return null
})

export type StorageSourceSettings = StorageSourceIntegration & {
  readonly config: IntegrationConfig
}

const decodeStoredClaim = Schema.decodeUnknownOption(ManifestClaim)

/**
 * The same answer as `storageSourceIntegrationFor`, with the row's settings,
 * read from the row alone: the `manifest` column the loader wrote, never the
 * plugins directory, so web can ask it across containers.
 */
export const storageSourceSettingsFor = Effect.fn('storageSourceSettingsFor')(
  function* (
    provider: string,
  ): Effect.fn.Return<StorageSourceSettings | null, StorageSourceLookupFailed> {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: integration.id,
            pluginId: integration.capabilityId,
            manifest: integration.manifest,
            config: integration.config,
          })
          .from(integration)
          .where(
            and(
              eq(integration.enabled, true),
              isNull(integration.removedAt),
              ne(integration.status, 'disabled'),
            ),
          )
          .orderBy(asc(integration.createdAt)),
      catch: (cause) => new StorageSourceLookupFailed({ cause }),
    })
    for (const row of rows) {
      const claims = Option.match(decodeStoredClaim(row.manifest), {
        onNone: () => false,
        onSome: (claim) =>
          claim.provides === 'storage-source' &&
          claim.requires?.connection?.provider === provider,
      })
      if (claims)
        return {
          integrationId: row.id,
          pluginId: row.pluginId,
          config: row.config,
        }
    }
    return null
  },
)

/** The provider's own page for a file, as "Open in Drive" opens it; null for a provider with none. */
export function canonicalFileUrl(
  provider: string,
  fileId: string,
): string | null {
  switch (provider) {
    case 'google':
      return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
    default:
      return null
  }
}
