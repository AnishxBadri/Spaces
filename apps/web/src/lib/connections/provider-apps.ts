import { Effect, Schema } from 'effect'
import { jsonString } from '@spaces/core/json'
import {
  PROVIDERS,
  PROVIDER_IDS,
  redirectUri,
} from '@spaces/core/providers/registry'
import type { ProviderId } from '@spaces/core/providers/registry'
import { countMembersConnected } from '@spaces/core/writes/connections/list'
import {
  mergeCredentialMeta,
  readWorkspaceCredential,
  redact,
  storeCredential,
} from '@spaces/core/writes/vault'
import { effectFn } from '#/lib/server/effect'
import { describeExternalOrigin } from '#/lib/server/external-origin'
import { requireAdmin, requireSettingsReader } from '#/lib/server/shared'
import { redactProviderApp } from '#/lib/settings-redact'
import type { ProviderAppInput, ProviderAppRow } from './input'

/**
 * The operator half of a provider: one OAuth app per provider, a workspace
 * `oauth_client` credential — client id in `meta`, secret encrypted.
 * - The write opens with `requireAdmin()`; the read is any member's, the
 *   secret's display redacted for them.
 * - The secret goes in and never comes back: rows carry `redact()` of it.
 * - Handlers live outside the server-fn barrel so a test drives them
 *   without a request; the server fns are one-line delegations.
 */

export class ProviderAppRefused extends Schema.TaggedError<ProviderAppRefused>()(
  'ProviderAppRefused',
  { message: Schema.String },
) {}

export class ProviderAppFailed extends Schema.TaggedError<ProviderAppFailed>()(
  'ProviderAppFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const KIND = 'oauth_client'

const query = <T>(message: string, f: () => Promise<T>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new ProviderAppFailed({ message, cause }),
  })

/** APP_URL as the app decided it, read per request so an edit needs no build. */
const origin = () => describeExternalOrigin(process.env.APP_URL).origin

export const providerAppProgram = Effect.fn('readProviderApp')(function* (
  provider: ProviderId,
): Effect.fn.Return<ProviderAppRow, ProviderAppFailed> {
  const row = yield* query('Could not read the OAuth client', () =>
    readWorkspaceCredential(provider, KIND),
  )
  const membersConnected = yield* query(
    'Could not count the connected members',
    () => countMembersConnected(provider),
  )
  return {
    provider,
    label: PROVIDERS[provider].label,
    configured: row !== undefined && row.status === 'active',
    clientId: jsonString(row?.meta.clientId),
    secretDisplay: jsonString(row?.meta.display),
    secretSetAt: jsonString(row?.meta.setAt),
    redirectUri: redirectUri(origin(), provider),
    membersConnected,
  }
})

export const getProviderAppsProgram = Effect.fn('getProviderApps')(
  function* (): Effect.fn.Return<ProviderAppRow[], ProviderAppFailed> {
    const rows: ProviderAppRow[] = []
    for (const provider of PROVIDER_IDS)
      rows.push(yield* providerAppProgram(provider))
    return rows
  },
)

/**
 * The providers with an active OAuth client — which Connect controls a
 * member may use. Ids only: nothing about the client leaves.
 */
export const getConfiguredProvidersProgram = Effect.fn(
  'getConfiguredProviders',
)(function* (): Effect.fn.Return<ProviderId[], ProviderAppFailed> {
  const configured: ProviderId[] = []
  for (const provider of PROVIDER_IDS) {
    const row = yield* query('Could not read the OAuth client', () =>
      readWorkspaceCredential(provider, KIND),
    )
    if (row?.status === 'active') configured.push(provider)
  }
  return configured
})

/**
 * Saves a provider's client. A secret replaces the stored one; an empty
 * secret keeps it and changes only the client id — which needs a stored one.
 */
export const setProviderAppProgram = Effect.fn('setProviderApp')(function* (
  actorId: string,
  data: ProviderAppInput,
): Effect.fn.Return<ProviderAppRow, ProviderAppRefused | ProviderAppFailed> {
  const { provider, clientId, clientSecret } = data
  if (clientSecret !== '') {
    yield* query('Could not save the OAuth client', () =>
      storeCredential({
        scope: 'workspace',
        provider,
        kind: KIND,
        secret: clientSecret,
        meta: {
          clientId,
          display: redact(clientSecret),
          setAt: new Date().toISOString(),
        },
        createdBy: actorId,
      }),
    )
    return yield* providerAppProgram(provider)
  }
  const existing = yield* query('Could not read the OAuth client', () =>
    readWorkspaceCredential(provider, KIND),
  )
  if (existing === undefined)
    return yield* new ProviderAppRefused({
      message: `Paste the ${PROVIDERS[provider].label} client secret`,
    })
  yield* query('Could not save the OAuth client', () =>
    mergeCredentialMeta(existing.id, { clientId }),
  )
  return yield* providerAppProgram(provider)
})

// The server fns' bodies. `requireAdmin()` first on the write.

/** Any member reads the clients; each secret's display is redacted for them. */
export async function getProviderAppsHandler(): Promise<ProviderAppRow[]> {
  const { isAdmin } = await requireSettingsReader()
  const apps = await effectFn(getProviderAppsProgram)()
  return isAdmin ? apps : apps.map(redactProviderApp)
}

export async function setProviderAppHandler(
  data: ProviderAppInput,
): Promise<ProviderAppRow> {
  const admin = await requireAdmin()
  return effectFn(setProviderAppProgram)(admin.id, data)
}
