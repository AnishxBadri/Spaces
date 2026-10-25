import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  entity,
  storageBinding,
  user,
} from '@spaces/db/schema'
import {
  bindingConflict,
  bindingConflictMessage,
  isBindableKind,
} from '../../documents/bindings'
import { raiseSensitivity } from '../ai/stamp-sensitivity'
import type { BindingFolder } from '../../documents/bindings'

/**
 * Storage bindings: the write at bind time, the Files tab's read, and Unlink.
 * - Every bind takes one transaction-scoped lock, so the overlap check and
 *   the insert cannot interleave with another bind; the unique index on
 *   (provider, folder_id) backs the same-folder case regardless.
 * - The folder's ancestry comes from the caller (the worker's `getFolder`):
 *   this module never reaches a provider.
 */

/** The options the bind dialog sets. */
export type BindingOptions = {
  readonly mapSubfolders: boolean
  readonly retain: 'full' | 'text'
  readonly direction: 'pull' | 'push' | 'both'
  readonly sensitivity: 'inherit' | 'sensitive'
}

export type BindFolderInput = {
  readonly connectionId: string
  readonly provider: string
  readonly folder: BindingFolder
  readonly targetEntityId: string
  readonly boundBy: string
  readonly options: BindingOptions
  /**
   * The provider's change cursor read before the bind (`changes(null).next`),
   * stored on a connection that has none, so the first poll picks up what
   * the first sync's walk passed by. A connection's own cursor is kept.
   */
  readonly startCursor?: string
}

/** The bind was refused; `reason` is the sentence the dialog shows. */
export class BindingRefused extends Schema.TaggedError<BindingRefused>()(
  'BindingRefused',
  { reason: Schema.String },
) {}

export class BindingStoreFailed extends Schema.TaggedError<BindingStoreFailed>()(
  'BindingStoreFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingStoreFailed({ cause }),
  })

const BIND_LOCK = 'storage_binding:bind'

export const NOT_BINDABLE =
  'A folder links to a company, a deal, a space or a custom record.'
export const RECORD_GONE = 'That record no longer exists.'

/** Why a record cannot hold a binding's files, or null when it can. */
const targetRefusal = (
  target:
    { readonly kind: string; readonly mergedIntoId: string | null } | undefined,
): string | null => {
  if (target === undefined || target.mergedIntoId !== null) return RECORD_GONE
  return isBindableKind(target.kind) ? null : NOT_BINDABLE
}

/**
 * The bound record's refusal, read now: `RECORD_GONE`, `NOT_BINDABLE`, or
 * null when it still takes the binding's files.
 */
export const bindingTargetRefusalProgram = Effect.fn(
  'bindingTargetRefusalProgram',
)(function* (
  targetEntityId: string,
): Effect.fn.Return<string | null, BindingStoreFailed> {
  const rows = yield* query(() =>
    db
      .select({ kind: entity.kind, mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, targetEntityId)),
  )
  return targetRefusal(rows.at(0))
})

type Outcome =
  | { readonly _tag: 'bound'; readonly id: string }
  | { readonly _tag: 'refused'; readonly reason: string }

/** One folder bound to one node, or the refusal naming what already owns it. */
export const bindFolderProgram = Effect.fn('bindFolderProgram')(function* (
  input: BindFolderInput,
): Effect.fn.Return<
  { readonly id: string },
  BindingRefused | BindingStoreFailed
> {
  const outcome: Outcome = yield* query(() =>
    db.transaction(async (tx): Promise<Outcome> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${BIND_LOCK}))`,
      )

      const refusal = targetRefusal(
        (
          await tx
            .select({ kind: entity.kind, mergedIntoId: entity.mergedIntoId })
            .from(entity)
            .where(eq(entity.id, input.targetEntityId))
        ).at(0),
      )
      if (refusal !== null) return { _tag: 'refused', reason: refusal }

      const { folder } = input
      const ancestors =
        folder.ancestorIds.length === 0
          ? sql`'{}'::text[]`
          : sql`array[${sql.join(
              folder.ancestorIds.map((id) => sql`${id}`),
              sql`, `,
            )}]::text[]`
      const near = await tx
        .select({
          folderId: storageBinding.folderId,
          ancestorIds: storageBinding.ancestorIds,
          path: storageBinding.folderPath,
          targetName: entity.canonicalName,
          binderName: user.name,
        })
        .from(storageBinding)
        .innerJoin(entity, eq(entity.id, storageBinding.targetEntityId))
        .leftJoin(user, eq(user.id, storageBinding.boundBy))
        .where(
          and(
            eq(storageBinding.provider, input.provider),
            or(
              eq(storageBinding.folderId, folder.folderId),
              sql`${storageBinding.folderId} = any(${ancestors})`,
              sql`${folder.folderId} = any(${storageBinding.ancestorIds})`,
            ),
          ),
        )
        .orderBy(asc(storageBinding.createdAt))
      const conflict = bindingConflict(
        folder,
        near.flatMap((row) =>
          row.folderId === null ? [] : [{ ...row, folderId: row.folderId }],
        ),
      )
      if (conflict !== null)
        return {
          _tag: 'refused',
          reason: bindingConflictMessage(folder, conflict),
        }

      const row = (
        await tx
          .insert(storageBinding)
          .values({
            connectionId: input.connectionId,
            provider: input.provider,
            grain: 'folder',
            folderId: folder.folderId,
            folderPath: folder.path,
            ancestorIds: [...folder.ancestorIds],
            targetEntityId: input.targetEntityId,
            direction: input.options.direction,
            retain: input.options.retain,
            mapSubfolders: input.options.mapSubfolders,
            sensitivity: input.options.sensitivity,
            boundBy: input.boundBy,
          })
          .returning({ id: storageBinding.id })
      ).at(0)
      if (row === undefined)
        throw new Error('storage_binding insert returned no row')
      // A sensitive binding raises whatever it already reaches, in the bind.
      await raiseSensitivity(tx, { kind: 'binding', bindingId: row.id })
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
      return { _tag: 'bound', id: row.id }
    }),
  )
  if (outcome._tag === 'refused')
    return yield* new BindingRefused({ reason: outcome.reason })
  return { id: outcome.id }
})

/** One binding as the Files tab draws it. */
export type RecordBinding = {
  readonly id: string
  readonly provider: string
  readonly folderPath: string
  readonly direction: BindingOptions['direction']
  readonly retain: BindingOptions['retain']
  readonly mapSubfolders: boolean
  readonly sensitivity: BindingOptions['sensitivity']
  readonly status: 'active' | 'error' | 'paused'
  readonly error: string | null
  readonly lastSyncedAt: Date | null
}

/**
 * The folder bindings on one record, oldest first: the Files tab's bands.
 * A followed file's binding is not a band; it is reached through the
 * document it follows.
 */
export const recordBindingsProgram = Effect.fn('recordBindingsProgram')(
  function* (
    entityId: string,
  ): Effect.fn.Return<ReadonlyArray<RecordBinding>, BindingStoreFailed> {
    return yield* query(() =>
      db
        .select({
          id: storageBinding.id,
          provider: storageBinding.provider,
          folderPath: storageBinding.folderPath,
          direction: storageBinding.direction,
          retain: storageBinding.retain,
          mapSubfolders: storageBinding.mapSubfolders,
          sensitivity: storageBinding.sensitivity,
          status: storageBinding.status,
          error: storageBinding.error,
          lastSyncedAt: storageBinding.lastSyncedAt,
        })
        .from(storageBinding)
        .where(
          and(
            eq(storageBinding.targetEntityId, entityId),
            eq(storageBinding.grain, 'folder'),
          ),
        )
        .orderBy(asc(storageBinding.createdAt)),
    )
  },
)

/**
 * Unlink: the binding row goes. Documents it filed stay where they are
 * filed and lose only `binding_id` (the FK nulls it); the provider is never
 * touched. False when there was no such binding.
 */
export const unlinkBindingProgram = Effect.fn('unlinkBindingProgram')(
  function* (bindingId: string): Effect.fn.Return<boolean, BindingStoreFailed> {
    const gone = yield* query(() =>
      db
        .delete(storageBinding)
        .where(eq(storageBinding.id, bindingId))
        .returning({ id: storageBinding.id }),
    )
    return gone.length > 0
  },
)
