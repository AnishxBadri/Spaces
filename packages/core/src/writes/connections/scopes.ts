import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import { PROVIDERS, isProviderId } from '../../providers/registry'
import type { ProviderScope } from '../../providers/registry'

/**
 * What a connection already holds, for the callers that grow it: the picker
 * asks `hasScopes` before opening, a folder binding before it binds.
 * - Scopes grow within one product's row (D66); another product's scopes
 *   are a separate connection, never a union.
 * - Takes no user: the worker calls it with a connection id it already owns.
 */

export class ConnectionNotFound extends Schema.TaggedError<ConnectionNotFound>()(
  'ConnectionNotFound',
  { connectionId: Schema.String, message: Schema.String },
) {}

export class ConnectionReadFailed extends Schema.TaggedError<ConnectionReadFailed>()(
  'ConnectionReadFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** `missing` lists the asked-for scopes the row lacks, in the order asked. */
export type ScopeCheck =
  | { readonly _tag: 'granted' }
  | { readonly _tag: 'missing'; readonly scopes: ReadonlyArray<string> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const readFailed = (cause: unknown) =>
  new ConnectionReadFailed({ message: 'Could not read the connection', cause })

export const hasScopes = Effect.fn('hasScopes')(function* (
  connectionId: string,
  scopes: ReadonlyArray<string>,
): Effect.fn.Return<ScopeCheck, ConnectionNotFound | ConnectionReadFailed> {
  const notFound = new ConnectionNotFound({
    connectionId,
    message: 'No such connection',
  })
  // Postgres refuses a malformed uuid as a syntax error, not an empty read.
  if (!UUID.test(connectionId)) return yield* notFound
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({ scopes: accountConnection.scopes })
        .from(accountConnection)
        .where(eq(accountConnection.id, connectionId))
        .limit(1),
    catch: readFailed,
  })
  const row = rows.at(0)
  if (row === undefined) return yield* notFound
  const missing = [...new Set(scopes)].filter((s) => !row.scopes.includes(s))
  return missing.length === 0
    ? { _tag: 'granted' }
    : { _tag: 'missing', scopes: missing }
})

/**
 * Whether the user already holds a connection for this product, under any
 * provider account and in any status: the start leg then asks the provider
 * to fold the earlier grant into the new one.
 */
export const holdsConnection = Effect.fn('holdsConnection')(function* (key: {
  readonly userId: string
  readonly provider: string
  readonly product: string
}): Effect.fn.Return<boolean, ConnectionReadFailed> {
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({ id: accountConnection.id })
        .from(accountConnection)
        .where(
          and(
            eq(accountConnection.userId, key.userId),
            eq(accountConnection.provider, key.provider),
            eq(accountConnection.product, key.product),
          ),
        )
        .limit(1),
    catch: readFailed,
  })
  return rows.length > 0
})

/**
 * Two scope sets as one, in registry order. A value the registry does not
 * list (or an unknown provider's) keeps its first-seen order after them.
 */
export function unionScopes(
  provider: string,
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): Array<string> {
  const all = [...new Set([...a, ...b])]
  if (!isProviderId(provider)) return all
  const vocabulary: ReadonlyArray<ProviderScope> = PROVIDERS[provider].scopes
  const known = vocabulary
    .filter((s) => all.includes(s.value))
    .map((s) => s.value)
  return [...known, ...all.filter((s) => !known.includes(s))]
}
