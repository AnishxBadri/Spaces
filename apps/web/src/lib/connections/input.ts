import { Schema } from 'effect'
import { KEYED_PROVIDER_IDS } from '@spaces/core/providers/keyed'
import type { KeyedProviderId } from '@spaces/core/providers/keyed'
import { PROVIDER_IDS } from '@spaces/core/providers/registry'
import type { ProviderId } from '@spaces/core/providers/registry'

const uuid = Schema.String.check(Schema.isUUID())

/** One list entry as a settings page saves it: trimmed, never blank. */
const entry = (max: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(max))

/**
 * A provider's OAuth app as its Set up tab saves it. Client-safe: the
 * server fn validates with it and the section types its draft by it.
 * - `clientSecret` empty keeps the stored secret; a first save needs one.
 */
export const providerAppInput = Schema.Struct({
  provider: Schema.Literals(PROVIDER_IDS),
  clientId: Schema.Trim.check(
    Schema.isMinLength(1, { message: 'Paste the client ID' }),
    Schema.isMaxLength(512),
  ),
  clientSecret: Schema.Trim.check(Schema.isMaxLength(4000)),
})

export type ProviderAppInput = typeof providerAppInput.Type

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
export const connectionIdInput = Schema.Struct({ connectionId: uuid })

export type ConnectionIdInput = typeof connectionIdInput.Type

/** One of the session user's connections as the accounts pages list it. Never a token. */
export type ConnectionListRow = {
  connectionId: string
  provider: ProviderId
  /** The product: `drive`, `calendar`, `gmail`, `box`. */
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
  /**
   * When the refresh token lapses, ISO, when the provider says. Google says
   * so only for an OAuth client in Testing mode — its 7-day refresh tokens.
   */
  refreshExpiresAt: string | null
}

/**
 * What Disconnect did at the provider before the row was deleted:
 * `unreachable` when the provider could not be asked and the row went anyway;
 * `kept` when another product of the same account still uses the grant, so
 * the provider was not asked.
 */
export type ConnectionDisconnectResult = {
  connectionId: string
  /** `none`: a pasted key, which has no grant at the provider to revoke. */
  revoke: 'revoked' | 'already-revoked' | 'unreachable' | 'kept' | 'none'
}

/** What the accounts pages under You draw. Never a token, never a client secret. */
export type AccountsView = {
  /** The reader's own connections, never another member's. */
  connections: ConnectionListRow[]
  /** Providers with an active OAuth client. */
  configured: ProviderId[]
  /** The bundled plugin ids installed here. */
  installed: string[]
  /** Of those, the ones the workspace has switched on. */
  enabled: string[]
}

/**
 * A synced mailbox's settings as its account page saves them. Entries
 * are checked again by the server against `senderEntry`.
 */
export const mailboxSyncInput = Schema.Struct({
  connectionId: uuid,
  shareBodies: Schema.Boolean,
  excludeSenders: Schema.Array(entry(320)).check(Schema.isMaxLength(500)),
  excludeLabels: Schema.Array(entry(256)).check(Schema.isMaxLength(200)),
})

export type MailboxSyncInput = typeof mailboxSyncInput.Type

/** A synced mailbox's settings as its account page draws them. */
export type MailboxSyncView = {
  shareBodies: boolean
  excludeSenders: string[]
  excludeLabels: string[]
}

/** What a save changed: bodies whose visibility moved, and mail the list now removes. */
export type MailboxSyncResult = {
  view: MailboxSyncView
  /** Bodies whose visibility changed with the toggle. */
  revisited: number
  /** Emails already synced that the exclude list now names, taken out. */
  removed: number
}

/** A member's own key for a recorder, pasted on You → Meeting notes. */
export const recorderKeyInput = Schema.Struct({
  provider: Schema.Literals(KEYED_PROVIDER_IDS),
  key: Schema.Trim.check(
    Schema.isMinLength(1, { message: 'Paste the key' }),
    Schema.isMaxLength(512),
  ),
})

export type RecorderKeyInput = typeof recorderKeyInput.Type

/** A recorder connection's ticks and opt-ins, applied at once. */
export const recorderSettingsInput = Schema.Struct({
  connectionId: uuid,
  folderIds: Schema.mutable(
    Schema.Array(entry(256)).check(Schema.isMaxLength(500)),
  ),
  typedNotes: Schema.Boolean,
  transcript: Schema.Boolean,
})

export type RecorderSettingsInput = typeof recorderSettingsInput.Type

/** One of the reader's recorder connections as Meeting notes draws it. Never the key. */
export type RecorderAccountView = {
  connectionId: string
  provider: KeyedProviderId
  email: string
  status: 'active' | 'error' | 'revoked'
  errorReason: string | null
  /** ISO; null until a run has synced it. */
  lastSyncAt: string | null
  /** The member's folders with their ticks; null when they could not be listed. */
  folders: Array<{ id: string; name: string; ticked: boolean }> | null
  foldersError: string | null
  typedNotes: boolean
  transcript: boolean
}

/** What a reader can do about a recorder provider. */
export type RecorderOffer = 'connect' | 'install' | 'ask' | 'unavailable'

/** You → Meeting notes: the reader's recorders and the providers they can add. */
export type MeetingNotesView = {
  accounts: RecorderAccountView[]
  providers: Array<{
    provider: KeyedProviderId
    label: string
    keyHint: string
    plugin: string
    offer: RecorderOffer
  }>
}

/** Where a Google workspace's accounts live: one company domain, or personal Gmail. */
export const GOOGLE_AUDIENCES = ['workspace', 'personal'] as const
export type GoogleAudience = (typeof GOOGLE_AUDIENCES)[number]

/** The OAuth consent screen's user type in Google Cloud. */
export const CONSENT_TYPES = ['internal', 'external'] as const
export type ConsentType = (typeof CONSENT_TYPES)[number]

/** A provider's Set up answers, `workspace.settings.providers.<id>`; null until asked. */
export type ProviderChoices = {
  audience: GoogleAudience | null
  consent: ConsentType | null
}

/** One Set up answer, applied at once. */
export const providerChoiceInput = Schema.Struct({
  provider: Schema.Literal('google'),
  audience: Schema.optional(Schema.Literals(GOOGLE_AUDIENCES)),
  consent: Schema.optional(Schema.Literals(CONSENT_TYPES)),
})

export type ProviderChoiceInput = typeof providerChoiceInput.Type

/** One provider by id, for its page. */
export const providerIdInput = Schema.Struct({
  provider: Schema.Literals(PROVIDER_IDS),
})

/** One use of a provider (a bundled plugin) as In use draws it. */
export type ProviderUse = {
  product: string
  /** `Gmail`, `Google Calendar`. */
  label: string
  plugin: string
  /** The plugin's live row; null when the image did not ship it. */
  integrationId: string | null
  /** `integration.enabled`: whether members may use it. */
  enabled: boolean
  /** Members holding a live connection for it. */
  people: number
  /** The latest sync of any of those connections, ISO. */
  lastSyncAt: string | null
  /** Failed runs in the last 7 days. */
  failed: number
  /** The first member whose connection for it is failing; null for none. */
  failedWho: string | null
}

/** One member's account under a provider, as Connected lists it. */
export type ProviderMember = {
  userId: string
  name: string
  email: string
  /** `Mail · Calendar`. */
  uses: string
  state: 'ok' | 'expired'
}

/** A provider's page: its client, the Set up answers, its uses and who is connected. */
export type ProviderPageView = {
  app: ProviderAppRow
  /** Google's answers; null for a provider that asks none. */
  choices: ProviderChoices | null
  uses: ProviderUse[]
  connected: ProviderMember[]
  /** Members of the workspace, suspended ones left out. */
  members: number
  /** The reader's own live account under the provider, for Test. */
  mine: string | null
}

/** One provider row on Settings → Connections. */
export type ConnectionsListRow = {
  provider: ProviderId
  label: string
  configured: boolean
  membersConnected: number
  members: number
  /** Google holds the client in Testing: grants lapse every 7 days. */
  testing: boolean
  /** The client itself refused (`Google said: invalid_client`); null when not. */
  error: string | null
}
