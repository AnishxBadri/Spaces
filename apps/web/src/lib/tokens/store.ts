import { createHash, randomBytes } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { apiToken } from '@spaces/db/schema/tokens'

/**
 * The token store (SPA-23, `docs/spec-ai-substrate.md` §5): mint, list,
 * revoke, and the one question the MCP endpoint asks — whose token is this?
 *
 * DECISION (owner, 2026-09-27, SPA-23 hitl resolved): per-user bearer tokens
 * in our own `api_token` table. No OAuth, and not better-auth's `mcp` or
 * `bearer` plugin. canRead is per user, so the credential is per user; the
 * required-env set is frozen at DATABASE_URL + APP_URL, so the store is a
 * table and no identity provider appears.
 *
 * The plaintext is 32 random bytes, base64url, behind `spk_` so a leaked one
 * is recognisable in a log or a paste. It is returned exactly once, from
 * `createApiTokenProgram`, and never stored: the row keeps its sha256 and a
 * display prefix. A random 256-bit secret needs no salt or slow hash — there
 * is nothing to brute-force — so the lookup is one indexed equality.
 *
 * It lives outside `lib/server/` so a test can drive it without a request
 * (CLAUDE.md, SPA-155), and it imports `node:crypto`, so the server fns in
 * `lib/server/tokens.ts` import it inside their handlers.
 */

export const TOKEN_PREFIX = 'spk_'
/** How much of the plaintext the ledger shows: `spk_` + eight characters. */
const DISPLAY_CHARS = TOKEN_PREFIX.length + 8
const NAME_MAX = 80

export class ApiTokenQueryFailed extends Schema.TaggedError<ApiTokenQueryFailed>()(
  'ApiTokenQueryFailed',
  { cause: Schema.Defect() },
) {}

export class ApiTokenRejected extends Schema.TaggedError<ApiTokenRejected>()(
  'ApiTokenRejected',
  { message: Schema.String },
) {}

/**
 * The bearer failed: absent, malformed, unknown, revoked, or its user is
 * banned. One tag for all of them — the endpoint answers 401 either way and
 * says nothing about which.
 */
export class ApiTokenUnauthorized extends Schema.TaggedError<ApiTokenUnauthorized>()(
  'ApiTokenUnauthorized',
  { message: Schema.String },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ApiTokenQueryFailed({ cause }),
  })

export function hashApiToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

export function mintApiToken(): {
  plaintext: string
  hash: string
  prefix: string
} {
  const plaintext = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  return {
    plaintext,
    hash: hashApiToken(plaintext),
    prefix: plaintext.slice(0, DISPLAY_CHARS),
  }
}

/** One ledger row. No hash, no plaintext — nothing a page could leak. */
export type ApiTokenRow = {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export type CreatedApiToken = ApiTokenRow & {
  /** The plaintext, this once. Nothing can read it back afterwards. */
  token: string
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export const createApiTokenProgram = Effect.fn('createApiTokenProgram')(
  function* (input: {
    userId: string
    name: string
  }): Effect.fn.Return<
    CreatedApiToken,
    ApiTokenRejected | ApiTokenQueryFailed
  > {
    const name = input.name.trim()
    if (!name) return yield* new ApiTokenRejected({ message: 'Name the token' })
    if (name.length > NAME_MAX)
      return yield* new ApiTokenRejected({
        message: `Keep the name under ${NAME_MAX} characters`,
      })
    const minted = mintApiToken()
    const row = (yield* query(() =>
      db
        .insert(apiToken)
        .values({
          userId: input.userId,
          name,
          tokenHash: minted.hash,
          prefix: minted.prefix,
        })
        .returning(),
    )).at(0)
    if (!row)
      return yield* new ApiTokenQueryFailed({ cause: 'insert returned no row' })
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      token: minted.plaintext,
    }
  },
)

/** The user's own tokens, newest first, revoked ones included. */
export const listApiTokensProgram = Effect.fn('listApiTokensProgram')(
  function* (
    userId: string,
  ): Effect.fn.Return<Array<ApiTokenRow>, ApiTokenQueryFailed> {
    const rows = yield* query(() =>
      db
        .select({
          id: apiToken.id,
          name: apiToken.name,
          prefix: apiToken.prefix,
          createdAt: apiToken.createdAt,
          lastUsedAt: apiToken.lastUsedAt,
          revokedAt: apiToken.revokedAt,
        })
        .from(apiToken)
        .where(eq(apiToken.userId, userId))
        .orderBy(desc(apiToken.createdAt), desc(apiToken.id)),
    )
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: iso(r.lastUsedAt),
      revokedAt: iso(r.revokedAt),
    }))
  },
)

/**
 * Revoke one of the user's own tokens. Scoped by `user_id`, so a token id
 * belonging to someone else reads as not found rather than as revoked.
 * Revoking twice is refused — the first `revoked_at` is the one that stands.
 */
export const revokeApiTokenProgram = Effect.fn('revokeApiTokenProgram')(
  function* (input: {
    userId: string
    id: string
  }): Effect.fn.Return<{ id: string }, ApiTokenRejected | ApiTokenQueryFailed> {
    const row = (yield* query(() =>
      db
        .update(apiToken)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiToken.id, input.id),
            eq(apiToken.userId, input.userId),
            isNull(apiToken.revokedAt),
          ),
        )
        .returning({ id: apiToken.id }),
    )).at(0)
    if (!row)
      return yield* new ApiTokenRejected({
        message: 'No live token of yours has that id',
      })
    return row
  },
)

/** Whose request this is, as the tools need it: an id for canRead. */
export type TokenUser = { id: string; name: string; tokenId: string }

const BEARER = /^Bearer\s+(\S+)\s*$/i

/**
 * Resolve an `Authorization` header to its user, or refuse. The lookup is
 * by hash; a revoked token, and a token whose user is banned, refuse like
 * an unknown one. A hit stamps `last_used_at`.
 */
export const authenticateBearerProgram = Effect.fn('authenticateBearerProgram')(
  function* (
    authorization: string | null,
  ): Effect.fn.Return<TokenUser, ApiTokenUnauthorized | ApiTokenQueryFailed> {
    const plaintext = authorization ? BEARER.exec(authorization)?.[1] : null
    if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX))
      return yield* new ApiTokenUnauthorized({ message: 'Unauthorized' })
    const hit = (yield* query(() =>
      db
        .select({
          tokenId: apiToken.id,
          userId: user.id,
          name: user.name,
          banned: user.banned,
        })
        .from(apiToken)
        .innerJoin(user, eq(user.id, apiToken.userId))
        .where(
          and(
            eq(apiToken.tokenHash, hashApiToken(plaintext)),
            isNull(apiToken.revokedAt),
          ),
        ),
    )).at(0)
    if (!hit || hit.banned)
      return yield* new ApiTokenUnauthorized({ message: 'Unauthorized' })
    yield* query(() =>
      db
        .update(apiToken)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiToken.id, hit.tokenId)),
    )
    return { id: hit.userId, name: hit.name, tokenId: hit.tokenId }
  },
)
