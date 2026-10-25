import { Effect } from 'effect'
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  min,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  objectDef,
  storageBinding,
  user,
} from '@spaces/db/schema'
import { PROVIDERS, isProviderId } from '../../providers/registry'
import { BindingStoreFailed } from './bind'
import { goneNot } from './gone'

/**
 * Binding health: what a binding whose binder left or whose token died
 * reads as, and the re-bind that moves it onto another member's connection.
 * - A binding's documents are deduped on (connection, external id), so a
 *   re-bind repoints `document.connection_id` with the binding, in one
 *   transaction, or the next sync would file every file again.
 * - The change cursor is the connection's, never the binding's: a re-bind
 *   carries none across and re-lists the folder with a full sync instead.
 * - Nothing here deletes a document or reaches a provider; the folder check
 *   is the worker's `getFolder`.
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingStoreFailed({ cause }),
  })

/** `Google said: File not found` — a provider's words, attributed. */
export const providerSaid = (provider: string, reason: string): string =>
  `${isProviderId(provider) ? PROVIDERS[provider].label : provider} said: ${reason}`

/** The scopes a connection must hold to read a whole bound folder, by provider. */
const REBIND_SCOPES: Readonly<Record<string, ReadonlyArray<string>>> = {
  google: ['drive.readonly'],
}

export const rebindScopesFor = (provider: string): ReadonlyArray<string> =>
  REBIND_SCOPES[provider] ?? []

/** Documents a binding brought and still tracks: what a re-list claims. */
const heldCount = sql<number>`(
  select count(*)::int from ${document}
  where ${document.bindingId} = ${storageBinding.id}
    and ${document.externalId} is not null
    and ${goneNot}
)`

/** A binding as the re-bind check reads it. */
export type RebindTarget = {
  readonly id: string
  readonly provider: string
  readonly folderId: string | null
  readonly folderPath: string
  readonly status: 'active' | 'error' | 'paused'
  readonly connectionId: string | null
  /** Files it already holds. */
  readonly files: number
}

/** The binding to re-bind, or null once it is unlinked. */
export const rebindTargetOf = Effect.fn('rebindTargetOf')(function* (
  bindingId: string,
): Effect.fn.Return<RebindTarget | null, BindingStoreFailed> {
  const row = (yield* query(() =>
    db
      .select({
        id: storageBinding.id,
        provider: storageBinding.provider,
        folderId: storageBinding.folderId,
        folderPath: storageBinding.folderPath,
        status: storageBinding.status,
        connectionId: storageBinding.connectionId,
        files: heldCount,
      })
      .from(storageBinding)
      .where(eq(storageBinding.id, bindingId)),
  )).at(0)
  return row ?? null
})

/** Why a binding cannot be re-bound now, or null when it can. */
export const rebindRefusal = (status: RebindTarget['status']): string | null =>
  status === 'active'
    ? 'This folder is syncing; only a paused or failing one is re-bound'
    : null

export type RebindInput = {
  readonly bindingId: string
  readonly connectionId: string
  readonly actorUserId: string
  /**
   * The new connection's change cursor read before the re-bind, stored only
   * when it has none — the same rule a bind follows.
   */
  readonly startCursor?: string
}

export type RebindOutcome =
  | {
      readonly _tag: 'rebound'
      /** Documents now held through the new connection. */
      readonly repointed: number
      /** Uploads still waiting to write through: each gets its export again. */
      readonly waiting: ReadonlyArray<string>
    }
  | { readonly _tag: 'refused'; readonly reason: string }

/**
 * The re-bind itself, after the worker's folder check: the binding moves to
 * the new connection, `active` and never synced, the binder becomes the
 * actor, and its documents move with it.
 * - A document the new connection already holds under the same external id
 *   stays where it is; the sync claims the held one, so nothing doubles.
 * - The binding row is locked first, so two re-binds cannot interleave.
 */
export const rebindBindingProgram = Effect.fn('rebindBindingProgram')(
  function* (
    input: RebindInput,
  ): Effect.fn.Return<RebindOutcome, BindingStoreFailed> {
    return yield* query(() =>
      db.transaction(async (tx): Promise<RebindOutcome> => {
        const binding = (
          await tx
            .select({ status: storageBinding.status })
            .from(storageBinding)
            .where(eq(storageBinding.id, input.bindingId))
            .for('update')
        ).at(0)
        if (binding === undefined)
          return { _tag: 'refused', reason: 'That folder is no longer linked' }
        const refusal = rebindRefusal(binding.status)
        if (refusal !== null) return { _tag: 'refused', reason: refusal }

        await tx
          .update(storageBinding)
          .set({
            connectionId: input.connectionId,
            status: 'active',
            error: null,
            lastSyncedAt: null,
            boundBy: input.actorUserId,
          })
          .where(eq(storageBinding.id, input.bindingId))

        const taken = tx
          .select({ externalId: document.externalId })
          .from(document)
          .where(
            and(
              eq(document.connectionId, input.connectionId),
              isNotNull(document.externalId),
            ),
          )
        const repointed = await tx
          .update(document)
          .set({ connectionId: input.connectionId })
          .where(
            and(
              eq(document.bindingId, input.bindingId),
              or(
                isNull(document.connectionId),
                ne(document.connectionId, input.connectionId),
              ),
              or(
                isNull(document.externalId),
                notInArray(document.externalId, taken),
              ),
            ),
          )
          .returning({ id: document.entityId })

        const waiting = await tx
          .select({ id: document.entityId })
          .from(document)
          .where(
            and(
              eq(document.bindingId, input.bindingId),
              eq(document.sourceClass, 'manual'),
              isNull(document.externalId),
              isNotNull(document.blobSha),
              goneNot,
            ),
          )

        if (input.startCursor !== undefined)
          await tx
            .update(accountConnection)
            .set({ storageCursor: input.startCursor })
            .where(
              and(
                eq(accountConnection.id, input.connectionId),
                isNull(accountConnection.storageCursor),
              ),
            )
        return {
          _tag: 'rebound',
          repointed: repointed.length,
          waiting: waiting.map((w) => w.id),
        }
      }),
    )
  },
)

type Writer = Pick<typeof db, 'update' | 'select'>

/**
 * Disconnect's half: every binding on the connection pauses, with the
 * sentence the bindings list reads (`Priya disconnected` and the UTC day). Its
 * documents are untouched. Run inside the disconnect's transaction, before
 * the row goes and the foreign key nulls `connection_id`.
 */
export async function pauseBindingsOf(
  tx: Writer,
  connectionId: string,
  at: Date,
): Promise<number> {
  const owner = (
    await tx
      .select({ name: user.name })
      .from(accountConnection)
      .innerJoin(user, eq(user.id, accountConnection.userId))
      .where(eq(accountConnection.id, connectionId))
  ).at(0)
  const who = owner?.name ?? 'Its owner'
  const paused = await tx
    .update(storageBinding)
    .set({
      status: 'paused',
      error: `${who} disconnected ${at.toISOString().slice(0, 10)}`,
    })
    .where(eq(storageBinding.connectionId, connectionId))
    .returning({ id: storageBinding.id })
  return paused.length
}

/** One binding as the account page's Bound folders ledger draws it. */
export type HealthBinding = {
  readonly id: string
  readonly provider: string
  readonly folderPath: string
  readonly targetId: string
  readonly targetName: string
  readonly targetKind: string
  /** A custom record's object, for its page. */
  readonly targetObjectSlug: string | null
  readonly status: 'active' | 'error' | 'paused'
  readonly error: string | null
  readonly lastSyncedAt: Date | null
  readonly connectionId: string | null
  readonly files: number
}

const healthColumns = {
  id: storageBinding.id,
  provider: storageBinding.provider,
  folderPath: storageBinding.folderPath,
  targetId: storageBinding.targetEntityId,
  targetName: entity.canonicalName,
  targetKind: entity.kind,
  targetObjectSlug: objectDef.slug,
  status: storageBinding.status,
  error: storageBinding.error,
  lastSyncedAt: storageBinding.lastSyncedAt,
  connectionId: storageBinding.connectionId,
  files: heldCount,
}

/**
 * The folder bindings an account page lists: every one on its connections,
 * then every paused or failing one of the same provider elsewhere — those
 * wait for someone to re-bind them. Oldest first within each. A followed
 * file is the Files tab's, never listed here.
 */
export const accountBindingsProgram = Effect.fn('accountBindingsProgram')(
  function* (input: {
    readonly provider: string
    readonly connectionIds: ReadonlyArray<string>
  }): Effect.fn.Return<ReadonlyArray<HealthBinding>, BindingStoreFailed> {
    const own =
      input.connectionIds.length === 0
        ? sql`false`
        : inArray(storageBinding.connectionId, [...input.connectionIds])
    const rows = yield* query(() =>
      db
        .select(healthColumns)
        .from(storageBinding)
        .innerJoin(entity, eq(entity.id, storageBinding.targetEntityId))
        .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
        .where(
          and(
            eq(storageBinding.provider, input.provider),
            eq(storageBinding.grain, 'folder'),
            or(own, ne(storageBinding.status, 'active')),
          ),
        )
        .orderBy(asc(storageBinding.createdAt)),
    )
    const mine = (r: HealthBinding) =>
      r.connectionId !== null && input.connectionIds.includes(r.connectionId)
    return [...rows.filter(mine), ...rows.filter((r) => !mine(r))]
  },
)

/** Every binding in `error`, folder or followed file, workspace-wide: one Today line each. */
export const failingBindingsProgram = Effect.fn('failingBindingsProgram')(
  function* (): Effect.fn.Return<
    ReadonlyArray<HealthBinding>,
    BindingStoreFailed
  > {
    return yield* query(() =>
      db
        .select(healthColumns)
        .from(storageBinding)
        .innerJoin(entity, eq(entity.id, storageBinding.targetEntityId))
        .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
        .where(eq(storageBinding.status, 'error'))
        .orderBy(asc(storageBinding.createdAt)),
    )
  },
)

/** Uploads waiting to reach one bound record's folder. */
export type WaitingByRecord = {
  readonly targetId: string
  readonly targetName: string
  readonly count: number
  /** The oldest one's arrival. */
  readonly since: Date
}

/**
 * The provider's export backlog by bound record, the account page's Exports
 * ledger: the same rows `waitingExportsProgram` counts.
 */
export const waitingExportsByRecordProgram = Effect.fn(
  'waitingExportsByRecordProgram',
)(function* (
  provider: string,
): Effect.fn.Return<ReadonlyArray<WaitingByRecord>, BindingStoreFailed> {
  const rows = yield* query(() =>
    db
      .select({
        targetId: storageBinding.targetEntityId,
        targetName: entity.canonicalName,
        count: sql<number>`count(*)::int`,
        since: min(document.createdAt),
      })
      .from(document)
      .innerJoin(storageBinding, eq(storageBinding.id, document.bindingId))
      .innerJoin(entity, eq(entity.id, storageBinding.targetEntityId))
      .where(
        and(
          eq(storageBinding.provider, provider),
          eq(document.sourceClass, 'manual'),
          isNull(document.externalId),
          isNotNull(document.blobSha),
          goneNot,
          inArray(storageBinding.direction, ['push', 'both']),
        ),
      )
      .groupBy(storageBinding.targetEntityId, entity.canonicalName)
      .orderBy(asc(entity.canonicalName)),
  )
  return rows.flatMap((r) =>
    r.since === null ? [] : [{ ...r, since: r.since }],
  )
})
