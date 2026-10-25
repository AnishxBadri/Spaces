import { Effect, Redacted, Result, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import type * as schema from '@spaces/db/schema'
import { jsonString } from '../../json'
import { PROVIDERS, isProviderId } from '../../providers/registry'
import type { ProviderEntry, ProviderId } from '../../providers/registry'
import { readWorkspaceCredential, resolveSecret } from '../vault/index'
import { decryptBundle, decryptConnectionBundle, encryptBundle } from './bundle'
import type { TokenBundle } from './bundle'
import { refreshGrant } from './exchange'

/**
 * `accessTokenFor(connectionId)`: the one accessor for a connection's
 * access token. Takes no user — ownership is the caller's to assert.
 * - Refreshes under `SELECT … FOR UPDATE` on the row and re-reads inside
 *   the lock, so of two processes racing, the loser returns the winner's
 *   token instead of spending a refresh token the provider already rotated.
 * - A refused refresh marks the row `error` with the provider's reason and
 *   keeps its scopes and bundle; an `error` or `revoked` row never yields a
 *   token and never reaches the provider.
 * - A pasted key is returned as it is: it has no expiry and no refresh.
 */

export class AuthExpired extends Schema.TaggedError<AuthExpired>()(
  'AuthExpired',
  { connectionId: Schema.String, message: Schema.String },
) {}

/** The provider (or its OAuth client) is unreachable; nothing changed. */
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()(
  'ProviderUnavailable',
  {
    connectionId: Schema.String,
    /** The provider's HTTP status; null when it never answered. */
    status: Schema.NullOr(Schema.Number),
    message: Schema.String,
  },
) {}

export class ConnectionNotFound extends Schema.TaggedError<ConnectionNotFound>()(
  'ConnectionNotFound',
  { connectionId: Schema.String, message: Schema.String },
) {}

export type ConnectionDb = NodePgDatabase<typeof schema>

/** The registry's endpoints; a test points them at the fake IdP. */
export type ProviderEndpoints = Readonly<
  Record<ProviderId, Pick<ProviderEntry, 'tokenUrl' | 'revokeUrl'>>
>

export type AccessTokenOptions = {
  /** Default the package's `db`; a test hands a second client. */
  readonly db?: ConnectionDb
  readonly providers?: ProviderEndpoints
  /** Refresh even when the token is fresh: Settings' "force a refresh". */
  readonly force?: boolean
}

/** A token this close to `expires_at` is refreshed before it is handed out. */
export const REFRESH_SKEW_MS = 60_000

export type ConnectionRow = typeof accountConnection.$inferSelect

/** The OAuth client the provider's tokens were issued to; null when unset. */
export async function oauthClientOf(
  provider: ProviderId,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const row = await readWorkspaceCredential(provider, 'oauth_client')
  const clientId =
    row?.status === 'active' ? jsonString(row.meta.clientId) : null
  const clientSecret = await resolveSecret(provider, 'oauth_client')
  if (clientId === null || clientSecret === null) return null
  return { clientId, clientSecret }
}

/** A connection's owner and state, never its tokens; undefined when gone. */
export async function connectionState(connectionId: string) {
  return (
    await db
      .select({
        userId: accountConnection.userId,
        status: accountConnection.status,
        expiresAt: accountConnection.expiresAt,
      })
      .from(accountConnection)
      .where(eq(accountConnection.id, connectionId))
  ).at(0)
}

export const bundleOf = (row: ConnectionRow): TokenBundle =>
  decryptBundle(row.tokensEnc, { userId: row.userId, provider: row.provider })

type Outcome =
  | { readonly kind: 'token'; readonly accessToken: string }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'expired'
      readonly reason: string
      /** This call's refused refresh put the row in `error`. */
      readonly marked: boolean
    }
  | {
      readonly kind: 'unavailable'
      readonly status: number | null
      readonly reason: string
    }

const after = (now: number, seconds: number | null) =>
  seconds === null ? null : new Date(now + seconds * 1000)

export const accessTokenFor = Effect.fn('accessTokenFor')(function* (
  connectionId: string,
  options: AccessTokenOptions = {},
): Effect.fn.Return<
  Redacted.Redacted<string>,
  AuthExpired | ProviderUnavailable | ConnectionNotFound
> {
  const handle = options.db ?? db
  const providers = options.providers ?? PROVIDERS
  const force = options.force ?? false

  const outcome = yield* Effect.promise(() =>
    handle.transaction(async (tx): Promise<Outcome> => {
      const row = (
        await tx
          .select()
          .from(accountConnection)
          .where(eq(accountConnection.id, connectionId))
          .for('update')
      ).at(0)
      if (row === undefined) return { kind: 'missing' }
      if (row.status !== 'active')
        return {
          kind: 'expired',
          marked: false,
          reason:
            row.status === 'revoked'
              ? 'The connection was revoked; connect again'
              : `The connection needs reconnecting (${row.errorReason ?? 'no reason given'})`,
        }
      const stored = decryptConnectionBundle(row.tokensEnc, {
        userId: row.userId,
        provider: row.provider,
      })
      if (stored.type === 'api_key')
        return { kind: 'token', accessToken: stored.key }
      if (!isProviderId(row.provider))
        return {
          kind: 'expired',
          marked: false,
          reason: `Unknown provider ${row.provider}`,
        }
      const provider: ProviderId = row.provider
      const bundle = bundleOf(row)

      const now = Date.now()
      const fresh =
        row.expiresAt === null ||
        row.expiresAt.getTime() - now > REFRESH_SKEW_MS
      if (fresh && !force)
        return { kind: 'token', accessToken: bundle.accessToken }

      const markError = async (reason: string): Promise<Outcome> => {
        await tx
          .update(accountConnection)
          .set({ status: 'error', errorReason: reason })
          .where(eq(accountConnection.id, connectionId))
        return { kind: 'expired', reason, marked: true }
      }
      if (bundle.refreshToken === null)
        return markError('The provider issued no refresh token')

      const client = await oauthClientOf(provider)
      if (client === null)
        return {
          kind: 'unavailable',
          status: null,
          reason:
            'The provider has no OAuth client; an admin adds it in Settings → Connections',
        }

      const refreshed = await Effect.runPromise(
        Effect.result(
          refreshGrant({
            tokenUrl: providers[provider].tokenUrl,
            refreshToken: bundle.refreshToken,
            ...client,
          }),
        ),
      )
      if (Result.isFailure(refreshed)) {
        const failure = refreshed.failure
        if (failure._tag === 'RefreshUnavailable')
          return {
            kind: 'unavailable',
            status: failure.status,
            reason: failure.message,
          }
        return markError(
          failure.description === null
            ? failure.error
            : `${failure.error}: ${failure.description}`,
        )
      }

      const grant = refreshed.success
      const next: TokenBundle = {
        accessToken: grant.bundle.accessToken,
        refreshToken: grant.bundle.refreshToken ?? bundle.refreshToken,
        tokenType: grant.bundle.tokenType,
      }
      const refreshTokenExpiresAt = after(now, grant.refreshTokenExpiresIn)
      await tx
        .update(accountConnection)
        .set({
          tokensEnc: encryptBundle(next, {
            userId: row.userId,
            provider: row.provider,
          }),
          expiresAt: after(now, grant.expiresIn),
          ...(refreshTokenExpiresAt === null ? {} : { refreshTokenExpiresAt }),
        })
        .where(eq(accountConnection.id, connectionId))
      return { kind: 'token', accessToken: next.accessToken }
    }),
  )

  switch (outcome.kind) {
    case 'token':
      return Redacted.make(outcome.accessToken)
    case 'missing':
      return yield* new ConnectionNotFound({
        connectionId,
        message: 'No such connection',
      })
    case 'expired':
      if (outcome.marked)
        yield* Effect.logWarning(
          `connection ${connectionId} lost its grant: ${outcome.reason}`,
        )
      return yield* new AuthExpired({ connectionId, message: outcome.reason })
    case 'unavailable':
      return yield* new ProviderUnavailable({
        connectionId,
        status: outcome.status,
        message: outcome.reason,
      })
  }
})
