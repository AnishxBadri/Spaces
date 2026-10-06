import { Effect, Result } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import { PROVIDERS, isProviderId } from '../../providers/registry'
import type { ProviderId } from '../../providers/registry'
import { postForm, providerError } from './exchange'
import {
  ConnectionNotFound,
  ProviderUnavailable,
  bundleOf,
  oauthClientOf,
} from './token'
import type { ConnectionDb, ProviderEndpoints } from './token'

/**
 * `revokeConnection(connectionId)`: posts the registry's `revokeUrl`, then
 * sets the row `revoked`. The caller deletes it (Disconnect).
 * - Google takes `token` alone; Box also wants the client's id and secret.
 * - The refresh token is the one revoked when there is one: revoking it
 *   kills the whole grant, the access token only one hour of it.
 * - A 4xx means the provider no longer knows the token: logged, reported
 *   `already-revoked`. No answer or a 5xx fails `ProviderUnavailable` and
 *   leaves the row as it was.
 * - Under the row lock, so a refresh in flight cannot rotate the token
 *   between our read and the provider's answer.
 */

export type RevokeOutcome = 'revoked' | 'already-revoked'

export type RevokeOptions = {
  readonly db?: ConnectionDb
  readonly providers?: ProviderEndpoints
}

type Outcome =
  | { readonly kind: 'done'; readonly outcome: RevokeOutcome }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'unavailable'
      readonly status: number | null
      readonly reason: string
    }
  | {
      readonly kind: 'refused'
      readonly status: number
      readonly error: string
    }

export const revokeConnection = Effect.fn('revokeConnection')(function* (
  connectionId: string,
  options: RevokeOptions = {},
): Effect.fn.Return<RevokeOutcome, ProviderUnavailable | ConnectionNotFound> {
  const handle = options.db ?? db
  const providers = options.providers ?? PROVIDERS

  const result = yield* Effect.promise(() =>
    handle.transaction(async (tx): Promise<Outcome> => {
      const row = (
        await tx
          .select()
          .from(accountConnection)
          .where(eq(accountConnection.id, connectionId))
          .for('update')
      ).at(0)
      if (row === undefined) return { kind: 'missing' }
      if (!isProviderId(row.provider))
        return {
          kind: 'unavailable',
          status: null,
          reason: `Unknown provider ${row.provider}`,
        }
      const provider: ProviderId = row.provider
      const bundle = bundleOf(row)
      const form = new URLSearchParams({
        token: bundle.refreshToken ?? bundle.accessToken,
      })
      if (provider === 'box') {
        const client = await oauthClientOf(provider)
        if (client === null)
          return {
            kind: 'unavailable',
            status: null,
            reason:
              'The provider has no OAuth client; an admin adds it in Settings → Connections',
          }
        form.set('client_id', client.clientId)
        form.set('client_secret', client.clientSecret)
      }

      const answer = await Effect.runPromise(
        Effect.result(postForm(providers[provider].revokeUrl, form)),
      )
      if (Result.isFailure(answer))
        return {
          kind: 'unavailable',
          status: null,
          reason: answer.failure.message,
        }
      const { status } = answer.success
      if (status >= 500 || status === 429)
        return {
          kind: 'unavailable',
          status,
          reason: `The revoke endpoint answered ${String(status)}`,
        }

      await tx
        .update(accountConnection)
        .set({ status: 'revoked' })
        .where(eq(accountConnection.id, connectionId))
      if (answer.success.ok) return { kind: 'done', outcome: 'revoked' }
      return {
        kind: 'refused',
        status,
        error: providerError(answer.success.json)?.error ?? 'no error code',
      }
    }),
  )

  switch (result.kind) {
    case 'done':
      return result.outcome
    case 'refused':
      yield* Effect.logWarning(
        `revoking connection ${connectionId} answered ${String(result.status)} (${result.error}); taking it as already revoked`,
      )
      return 'already-revoked'
    case 'missing':
      return yield* new ConnectionNotFound({
        connectionId,
        message: 'No such connection',
      })
    case 'unavailable':
      return yield* new ProviderUnavailable({
        connectionId,
        status: result.status,
        message: result.reason,
      })
  }
})
