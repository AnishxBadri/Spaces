/**
 * The OAuth provider registry: one OAuth app per provider, registered once by
 * the operator (client id in the `oauth_client` credential's meta, secret
 * encrypted), under which N plugins hang. Pure data, client-safe.
 * - A manifest's `requires.connection.scopes` names `value`s from here;
 *   `wire` is what the authorize request sends.
 * - Least privilege (D66): Drive asks `drive.file` for the picker and adds
 *   `drive.readonly` only when a folder is bound, incrementally; never full
 *   `drive`, never `mail.google.com`, `gmail.compose` or `gmail.modify`.
 */

export type ProviderScope = {
  /** The name a manifest declares, e.g. `drive.file`. */
  readonly value: string
  /** The scope string the authorize request carries. */
  readonly wire: string
  readonly label: string
  /** The plugin that asks for it; `null` for core's own (sign-in, userinfo). */
  readonly plugin: string | null
  /** In the provider's restricted class, which brings a security assessment. */
  readonly restricted: boolean
}

export type ProviderEntry = {
  readonly label: string
  readonly authUrl: string
  readonly tokenUrl: string
  readonly revokeUrl: string
  readonly userinfoUrl: string
  readonly scopes: ReadonlyArray<ProviderScope>
}

/** Google's short names expand under googleapis.com/auth; the OIDC ones do not. */
const google = (
  value: string,
  label: string,
  plugin: string | null,
  restricted: boolean,
): ProviderScope => ({
  value,
  wire:
    value === 'openid' || value === 'email'
      ? value
      : `https://www.googleapis.com/auth/${value}`,
  label,
  plugin,
  restricted,
})

export const PROVIDERS = {
  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: [
      google('openid', 'Sign in', null, false),
      google('email', 'Email address', null, false),
      google('drive.file', 'Files picked in Drive', 'google-drive', false),
      google(
        'drive.readonly',
        'Read bound Drive folders',
        'google-drive',
        true,
      ),
      google(
        'calendar.events.readonly',
        'Read calendar events',
        'calendar',
        false,
      ),
      google('gmail.readonly', 'Read mail', 'gmail', true),
      google('gmail.send', 'Send mail', 'gmail', false),
    ],
  },
  box: {
    label: 'Box',
    authUrl: 'https://account.box.com/api/oauth2/authorize',
    tokenUrl: 'https://api.box.com/oauth2/token',
    revokeUrl: 'https://api.box.com/oauth2/revoke',
    userinfoUrl: 'https://api.box.com/2.0/users/me',
    scopes: [
      {
        value: 'root_readonly',
        wire: 'root_readonly',
        label: 'Read files and folders',
        plugin: 'box',
        restricted: false,
      },
      {
        value: 'root_readwrite',
        wire: 'root_readwrite',
        label: 'Read and write files and folders',
        plugin: 'box',
        restricted: false,
      },
    ],
  },
} as const satisfies Record<string, ProviderEntry>

export type ProviderId = keyof typeof PROVIDERS

/** The registry's ids, in the order the settings section draws them. */
export const PROVIDER_IDS = [
  'google',
  'box',
] as const satisfies ReadonlyArray<ProviderId>

export function isProviderId(id: string): id is ProviderId {
  return PROVIDER_IDS.some((p) => p === id)
}

/**
 * The scopes a connection asks for that its provider does not list — empty
 * when every one is known. An unknown provider knows none.
 */
export function unknownScopes(
  provider: string,
  scopes: ReadonlyArray<string>,
): Array<string> {
  if (!isProviderId(provider)) return [...scopes]
  const known: ReadonlyArray<ProviderScope> = PROVIDERS[provider].scopes
  return scopes.filter((s) => !known.some((k) => k.value === s))
}

/**
 * Where the provider sends the user back: `<origin>/api/connections/<id>/callback`.
 * `origin` is APP_URL as the app decided it; a trailing slash is dropped.
 */
export function redirectUri(origin: string, provider: ProviderId): string {
  return `${origin.replace(/\/$/, '')}/api/connections/${provider}/callback`
}
