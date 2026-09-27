import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { apiToken } from '@spaces/db/schema/tokens'
import { API_SCOPES, isApiScope } from './scopes'
import type { ApiScope } from './scopes'

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
 * One store, two doors (SPA-48): the same rows open the MCP endpoint and the
 * external HttpApi door at `/api/v1`, and `createApiTokenProgram` is the one
 * insert into `api_token` (`store.test.ts` greps for a second). What differs
 * is only what each door asks of the answer: the API door also checks the
 * token's `scopes` against the procedure's, the MCP server does not (see
 * `handleMcpRequest`).
 *
 * The plaintext is never logged: nothing in this module or its two callers
 * writes it anywhere, and a failure carries the fixed message
 * "Unauthorized", never the header it was given.
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
  scopes: Array<ApiScope>
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export type CreatedApiToken = ApiTokenRow & {
  /** The plaintext, this once. Nothing can read it back afterwards. */
  token: string
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

/**
 * The column is `text[]`; this is where it gets its type. A value the pinned
 * list no longer knows grants nothing, and the order is the list's, so two
 * tokens with the same grant read the same.
 */
const decodeScopes = (stored: ReadonlyArray<string>): Array<ApiScope> =>
  API_SCOPES.filter((scope) => stored.some((s) => s === scope))

export const createApiTokenProgram = Effect.fn('createApiTokenProgram')(
  function* (input: {
    userId: string
    name: string
    /** What the token may do at `/api/v1`. Omitted: nothing scoped. */
    scopes?: ReadonlyArray<string>
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
    const requested = input.scopes ?? []
    const unknown = requested.filter((s) => !isApiScope(s))
    if (unknown.length > 0)
      return yield* new ApiTokenRejected({
        message: `Unknown scope ${unknown.join(', ')}`,
      })
    const scopes = decodeScopes(requested)
    const minted = mintApiToken()
    const row = (yield* query(() =>
      db
        .insert(apiToken)
        .values({
          userId: input.userId,
          name,
          tokenHash: minted.hash,
          prefix: minted.prefix,
          scopes,
        })
        .returning(),
    )).at(0)
    if (!row)
      return yield* new ApiTokenQueryFailed({ cause: 'insert returned no row' })
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: decodeScopes(row.scopes),
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
          scopes: apiToken.scopes,
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
      scopes: decodeScopes(r.scopes),
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

/**
 * Whose request this is: an id for canRead, and what the token was granted.
 * The MCP tools read `id`; the API door reads `scopes` too.
 */
export type TokenUser = {
  id: string
  name: string
  email: string
  tokenId: string
  scopes: Array<ApiScope>
}

const BEARER = /^Bearer\s+(\S+)\s*$/i

/**
 * The two digests, compared in constant time. The row was found by an
 * indexed equality on `token_hash`, and that comparison runs over the
 * sha256 of the caller's own input — its timing can say nothing about a
 * stored secret, only about a digest whose preimage the caller already
 * holds. This is the comparison the code itself makes, so it is the one
 * that must not short-circuit: `timingSafeEqual` over the raw 32 bytes.
 */
function digestsMatch(storedHex: string, presentedHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex')
  const presented = Buffer.from(presentedHex, 'hex')
  return (
    stored.length === presented.length && timingSafeEqual(stored, presented)
  )
}

/**
 * Resolve a bearer credential — the token itself, already out of its header
 * — to its user and grant, or refuse. The lookup is by hash; a revoked
 * token, and a token whose user is banned, refuse like an unknown one, with
 * the same message. A hit stamps `last_used_at`, which the settings ledger
 * lists.
 */
export const authenticateTokenProgram = Effect.fn('authenticateTokenProgram')(
  function* (
    plaintext: string,
  ): Effect.fn.Return<TokenUser, ApiTokenUnauthorized | ApiTokenQueryFailed> {
    if (!plaintext.startsWith(TOKEN_PREFIX))
      return yield* new ApiTokenUnauthorized({ message: 'Unauthorized' })
    const presented = hashApiToken(plaintext)
    const hit = (yield* query(() =>
      db
        .select({
          tokenId: apiToken.id,
          tokenHash: apiToken.tokenHash,
          scopes: apiToken.scopes,
          userId: user.id,
          name: user.name,
          email: user.email,
          banned: user.banned,
        })
        .from(apiToken)
        .innerJoin(user, eq(user.id, apiToken.userId))
        .where(
          and(eq(apiToken.tokenHash, presented), isNull(apiToken.revokedAt)),
        ),
    )).at(0)
    if (!hit || hit.banned || !digestsMatch(hit.tokenHash, presented))
      return yield* new ApiTokenUnauthorized({ message: 'Unauthorized' })
    yield* query(() =>
      db
        .update(apiToken)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiToken.id, hit.tokenId)),
    )
    return {
      id: hit.userId,
      name: hit.name,
      email: hit.email,
      tokenId: hit.tokenId,
      scopes: decodeScopes(hit.scopes),
    }
  },
)

/**
 * Resolve an `Authorization` header — what the MCP endpoint is handed — to
 * its user, or refuse exactly as `authenticateTokenProgram` does.
 */
export const authenticateBearerProgram = Effect.fn('authenticateBearerProgram')(
  function* (
    authorization: string | null,
  ): Effect.fn.Return<TokenUser, ApiTokenUnauthorized | ApiTokenQueryFailed> {
    const plaintext = authorization ? BEARER.exec(authorization)?.[1] : null
    if (!plaintext)
      return yield* new ApiTokenUnauthorized({ message: 'Unauthorized' })
    return yield* authenticateTokenProgram(plaintext)
  },
)
