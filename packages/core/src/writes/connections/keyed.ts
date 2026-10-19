import { Effect, Redacted, Schema } from 'effect'
import { z } from 'zod'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import { readRecorderSettings, recorderSettingsJson } from '../../json'
import type { RecorderSettings } from '../../json'
import { KEYED_PROVIDERS, KEYED_PROVIDER_IDS } from '../../providers/keyed'
import type { KeyedProviderId } from '../../providers/keyed'
import { removeConnectionRecordings } from '../interactions/recorded-note'
import type { FetchLike } from '../ports/http'
import { encryptBundle } from './bundle'
import { forgetConnection } from './list'
import { accessTokenFor } from './token'

/**
 * A personal connection made from a key the member pastes (D78): Granola's
 * You → Meeting notes. The key is an `account_connection` row — `api_key`
 * bundle under the connection AAD, no expiry, no scopes — so it lists
 * beside the OAuth accounts and `accessTokenFor` hands it to the plugin.
 * - Pasting it asks the provider whose key it is; a refused key writes
 *   nothing.
 * - The folder ticks and the two opt-ins are `settings`; the folders are
 *   listed from the provider with the member's own key.
 * - Disconnect removes every recorded note the connection's runs wrote, then
 *   the row. There is no provider revoke: the key is the member's own.
 */

/** The provider refused the key. */
export class KeyRefused extends Schema.TaggedError<KeyRefused>()('KeyRefused', {
  message: Schema.String,
}) {}

/** The provider could not be asked; nothing changed. */
export class KeyedProviderUnavailable extends Schema.TaggedError<KeyedProviderUnavailable>()(
  'KeyedProviderUnavailable',
  { status: Schema.NullOr(Schema.Number), message: Schema.String },
) {}

/** Not the member's connection, or not a keyed one; one answer for both. */
export class KeyedConnectionNotFound extends Schema.TaggedError<KeyedConnectionNotFound>()(
  'KeyedConnectionNotFound',
  { message: Schema.String },
) {}

export type KeyedOptions = {
  /** The provider's transport; the network when absent. */
  readonly fetch?: FetchLike
}

const networkFetch: FetchLike = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers })

const owner = z.object({ email: z.email() })
const folders = z.object({
  folders: z.array(z.object({ id: z.string().min(1), name: z.string() })),
})

/** One read with the key; its JSON, or why not. */
const read = Effect.fn('keyed.read')(function* (
  provider: KeyedProviderId,
  path: string,
  key: string,
  options: KeyedOptions,
): Effect.fn.Return<unknown, KeyRefused | KeyedProviderUnavailable> {
  const entry = KEYED_PROVIDERS[provider]
  const response = yield* Effect.tryPromise({
    try: () =>
      (options.fetch ?? networkFetch)(`${entry.api}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      }),
    catch: () =>
      new KeyedProviderUnavailable({
        status: null,
        message: `${entry.label} did not answer`,
      }),
  })
  if (response.status === 401 || response.status === 403)
    return yield* new KeyRefused({
      message: `${entry.label} refused the key`,
    })
  if (response.status !== 200)
    return yield* new KeyedProviderUnavailable({
      status: response.status,
      message: `${entry.label} answered ${response.status}`,
    })
  return yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: () =>
      new KeyedProviderUnavailable({
        status: response.status,
        message: `${entry.label} sent a reply that is not JSON`,
      }),
  })
})

const unreadable = (provider: KeyedProviderId, what: string) =>
  new KeyedProviderUnavailable({
    status: 200,
    message: `${KEYED_PROVIDERS[provider].label} sent ${what} this cannot read`,
  })

/** The member a key belongs to, by the provider's own answer. */
const keyOwner = Effect.fn('keyed.owner')(function* (
  provider: KeyedProviderId,
  key: string,
  options: KeyedOptions,
) {
  const parsed = owner.safeParse(yield* read(provider, '/me', key, options))
  if (!parsed.success) return yield* unreadable(provider, 'an account')
  return parsed.data.email.toLowerCase()
})

/**
 * The key pasted on You → Meeting notes: one row, or the same row with the
 * new key when the member pastes again for the same account.
 */
export const connectKeyProgram = Effect.fn('connectKey')(function* (
  input: {
    readonly userId: string
    readonly provider: KeyedProviderId
    readonly key: string
  },
  options: KeyedOptions = {},
): Effect.fn.Return<
  { readonly connectionId: string; readonly email: string },
  KeyRefused | KeyedProviderUnavailable
> {
  const key = input.key.trim()
  if (key.length === 0 || key.length > 512 || /\s/.test(key))
    return yield* new KeyRefused({ message: 'That is not a key' })
  const email = yield* keyOwner(input.provider, key, options)
  const entry = KEYED_PROVIDERS[input.provider]
  const tokensEnc = encryptBundle(
    { type: 'api_key', key },
    { userId: input.userId, provider: input.provider },
  )
  const row = yield* Effect.promise(() =>
    db
      .insert(accountConnection)
      .values({
        userId: input.userId,
        provider: input.provider,
        product: entry.product,
        externalEmail: email,
        tokensEnc,
        scopes: [],
        expiresAt: null,
      })
      .onConflictDoUpdate({
        target: [
          accountConnection.userId,
          accountConnection.provider,
          accountConnection.product,
          accountConnection.externalEmail,
        ],
        set: { tokensEnc, status: 'active', errorReason: null },
      })
      .returning({ id: accountConnection.id }),
  )
  const id = row.at(0)?.id
  if (id === undefined) return yield* Effect.die('the key row was not written')
  return { connectionId: id, email }
})

/** One of the member's keyed rows, never another's. */
const ownKeyed = Effect.fn('keyed.own')(function* (
  userId: string,
  connectionId: string,
) {
  const row = yield* Effect.promise(async () =>
    (
      await db
        .select({
          id: accountConnection.id,
          provider: accountConnection.provider,
          externalEmail: accountConnection.externalEmail,
          status: accountConnection.status,
          errorReason: accountConnection.errorReason,
          lastSyncAt: accountConnection.lastSyncAt,
          settings: accountConnection.settings,
          createdAt: accountConnection.createdAt,
        })
        .from(accountConnection)
        .where(
          and(
            eq(accountConnection.id, connectionId),
            eq(accountConnection.userId, userId),
            inArray(accountConnection.provider, [...KEYED_PROVIDER_IDS]),
          ),
        )
    ).at(0),
  )
  const provider = KEYED_PROVIDER_IDS.find((p) => p === row?.provider)
  if (row === undefined || provider === undefined)
    return yield* new KeyedConnectionNotFound({
      message: 'Not your connection',
    })
  return { ...row, provider }
})

export type RecorderFolder = {
  readonly id: string
  readonly name: string
  readonly ticked: boolean
}

export type RecorderAccount = {
  readonly connectionId: string
  readonly provider: KeyedProviderId
  readonly email: string
  readonly status: 'active' | 'error' | 'revoked'
  readonly errorReason: string | null
  readonly lastSyncAt: Date | null
  readonly settings: RecorderSettings
  /** The member's folders, ticked as `settings` says; null when they could not be listed. */
  readonly folders: ReadonlyArray<RecorderFolder> | null
  /** Why the folders are not listed; null when they are. */
  readonly foldersError: string | null
}

/** The member's keyed connections, oldest first, without their folders. */
export async function listKeyedConnections(userId: string) {
  return db
    .select({
      id: accountConnection.id,
      provider: accountConnection.provider,
      email: accountConnection.externalEmail,
      status: accountConnection.status,
    })
    .from(accountConnection)
    .where(
      and(
        eq(accountConnection.userId, userId),
        inArray(accountConnection.provider, [...KEYED_PROVIDER_IDS]),
      ),
    )
    .orderBy(asc(accountConnection.createdAt))
}

/** One keyed connection with its folders listed from the provider, under the member's key. */
export const recorderAccountProgram = Effect.fn('recorderAccount')(function* (
  userId: string,
  connectionId: string,
  options: KeyedOptions = {},
): Effect.fn.Return<RecorderAccount, KeyedConnectionNotFound> {
  const row = yield* ownKeyed(userId, connectionId)
  const settings = readRecorderSettings(row.settings)
  const listed = yield* accessTokenFor(connectionId).pipe(
    Effect.mapError((e) => new KeyRefused({ message: e.message })),
    Effect.flatMap((key) =>
      read(row.provider, '/folders', Redacted.value(key), options),
    ),
    Effect.flatMap((json) => {
      const parsed = folders.safeParse(json)
      return parsed.success
        ? Effect.succeed(parsed.data.folders)
        : Effect.fail(unreadable(row.provider, 'folders'))
    }),
    Effect.result,
  )
  const base = {
    connectionId: row.id,
    provider: row.provider,
    email: row.externalEmail,
    status: row.status,
    errorReason: row.errorReason,
    lastSyncAt: row.lastSyncAt,
    settings,
  }
  if (listed._tag === 'Failure')
    return { ...base, folders: null, foldersError: listed.failure.message }
  const ticked = new Set(settings.folderIds)
  return {
    ...base,
    folders: listed.success.map((f) => ({
      id: f.id,
      name: f.name,
      ticked: ticked.has(f.id),
    })),
    foldersError: null,
  }
})

/**
 * The member's ticks and opt-ins, applied at once (D81). The next run fetches
 * from the ticked folders only and removes what an unticked one held.
 */
export const saveRecorderSettingsProgram = Effect.fn('saveRecorderSettings')(
  function* (
    userId: string,
    connectionId: string,
    settings: RecorderSettings,
  ): Effect.fn.Return<RecorderSettings, KeyedConnectionNotFound> {
    yield* ownKeyed(userId, connectionId)
    const stored = recorderSettingsJson(settings)
    yield* Effect.promise(() =>
      db
        .update(accountConnection)
        .set({ settings: stored })
        .where(eq(accountConnection.id, connectionId)),
    )
    return readRecorderSettings(stored)
  },
)

/** Disconnect: every recorded note the connection's runs wrote, then the row. */
export const disconnectKeyedProgram = Effect.fn('disconnectKeyed')(function* (
  userId: string,
  connectionId: string,
): Effect.fn.Return<{ readonly removed: number }, KeyedConnectionNotFound> {
  yield* ownKeyed(userId, connectionId)
  const removed = yield* Effect.promise(() =>
    removeConnectionRecordings(connectionId),
  )
  const forgotten = yield* Effect.promise(() =>
    forgetConnection(userId, connectionId),
  )
  if (!forgotten)
    return yield* new KeyedConnectionNotFound({
      message: 'Not your connection',
    })
  return { removed }
})
