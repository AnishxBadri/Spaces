import { z } from 'zod'
import { PROVIDER_IDS } from '@spaces/core/providers/registry'
import type { ProviderId } from '@spaces/core/providers/registry'

/**
 * A provider's OAuth app as Settings → Connection apps saves it. Client-safe: the
 * server fn validates with it and the section types its draft by it.
 * - `clientSecret` empty keeps the stored secret; a first save needs one.
 */
export const providerAppInput = z.object({
  provider: z.enum(PROVIDER_IDS),
  clientId: z.string().trim().min(1, 'Paste the client ID').max(512),
  clientSecret: z.string().trim().max(4000),
})

export type ProviderAppInput = z.infer<typeof providerAppInput>

/** One provider's OAuth app as the section draws it. The secret never leaves. */
export type ProviderAppRow = {
  provider: ProviderId
  label: string
  configured: boolean
  clientId: string | null
  /** `redact()` of the stored secret; null when none is stored. */
  secretDisplay: string | null
  /** When the secret was last saved, ISO; null when none is stored. */
  secretSetAt: string | null
  /** `<APP_URL>/api/connections/<provider>/callback`, read per request. */
  redirectUri: string
  /** Members holding a live connection through this client. */
  membersConnected: number
}

/** One of the session user's connections, by id. */
export const connectionIdInput = z.object({ connectionId: z.uuid() })

export type ConnectionIdInput = z.infer<typeof connectionIdInput>

/** A connection after a refresh, as an account page draws it. Never a token. */
export type ConnectionCustodyRow = {
  connectionId: string
  status: 'active' | 'error' | 'revoked'
  /** When the access token lapses, ISO; null when the provider did not say. */
  expiresAt: string | null
}

/** What a revoke did at the provider: `already-revoked` when it no longer knew the token. */
export type ConnectionRevokeResult = {
  connectionId: string
  outcome: 'revoked' | 'already-revoked'
}

/** One of the session user's connections as the accounts pages list it. Never a token. */
export type ConnectionListRow = {
  connectionId: string
  provider: ProviderId
  /** The D66 product: `drive`, `calendar`, `gmail`, `box`. */
  product: string
  externalEmail: string
  /** Registry `value`s, as granted. */
  scopes: string[]
  status: 'active' | 'error' | 'revoked'
  /** The provider's reason when `status` is `error`. */
  errorReason: string | null
  /** ISO; null until a sync has run. */
  lastSyncAt: string | null
  /** When the row was first made, ISO; the earliest mail account is the Default. */
  connectedAt: string
}

/**
 * What Disconnect did at the provider before the row was deleted:
 * `unreachable` when the provider could not be asked and the row went anyway;
 * `kept` when another product of the same account still uses the grant, so
 * the provider was not asked.
 */
export type ConnectionDisconnectResult = {
  connectionId: string
  revoke: 'revoked' | 'already-revoked' | 'unreachable' | 'kept'
}

/** What the accounts pages under You draw. Never a token, never a client secret. */
export type AccountsView = {
  /** The reader's own connections, never another member's. */
  connections: ConnectionListRow[]
  /** Providers with an active OAuth client. */
  configured: ProviderId[]
  /** Plugin ids installed here. */
  installed: string[]
  /** Plugin ids the registry offers that are not installed. */
  offered: string[]
}
