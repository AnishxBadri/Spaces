import { Effect } from 'effect'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  documentRevision,
  storageBinding,
} from '@spaces/db/schema'
import type { StorageSource } from '@spaces/sdk'
import { revisionLedger } from '../../documents/revisions'
import type { RevisionRow } from '../../documents/revisions'
import type { Enqueue } from '../../queue/enqueue'
import { raiseSensitivity } from '../ai/stamp-sensitivity'
import {
  BindingRefused,
  BindingStoreFailed,
  bindingTargetRefusalProgram,
} from './bind'
import { markGoneProgram } from './gone'
import { advanceToFileProgram } from './revise'
import type { HeldDocument, ReviseOutcome } from './revise'
import type { SyncFailure } from './sync'

/**
 * Live files: one filed document followed at its provider by a `grain =
 * 'file'` binding, pull only.
 * - Following attaches the binding to the document already filed — the row
 *   is `(connection_id, external_id)`, so there is never a second one.
 * - It runs on the document's connection and shares that connection's
 *   change poll: following ten files adds no `changes` pass.
 * - Unfollow pauses the binding and keeps it on the document, so the row
 *   can say when it stopped; every revision stays. Follow again resumes it.
 * - A provider delete marks the document gone and pauses the binding.
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingStoreFailed({ cause }),
  })

export const FOLLOW_REFUSALS = {
  missing: 'That file no longer exists.',
  notFromSource: 'Only a file from a storage connection can be followed.',
  gone: 'The file was deleted in its source; there is nothing to follow.',
  noConnection: 'The connection this file came through is not active.',
  inFolder: 'This file already syncs with its linked folder.',
} as const

type Followed =
  | { readonly _tag: 'followed'; readonly bindingId: string }
  | { readonly _tag: 'refused'; readonly reason: string }

/**
 * Follow one filed document from the record it was followed on. Refused
 * when it did not come from a storage connection, is gone at the provider,
 * or a folder binding already brings it.
 */
export const followFileProgram = Effect.fn('followFileProgram')(
  function* (input: {
    readonly documentId: string
    readonly targetEntityId: string
    readonly userId: string
  }): Effect.fn.Return<
    { readonly bindingId: string },
    BindingRefused | BindingStoreFailed
  > {
    const targetRefusal = yield* bindingTargetRefusalProgram(
      input.targetEntityId,
    )
    if (targetRefusal !== null)
      return yield* new BindingRefused({ reason: targetRefusal })

    const outcome: Followed = yield* query(() =>
      db.transaction(async (tx): Promise<Followed> => {
        // The row lock is the guard: two follows of one document queue here,
        // and the second finds the first's binding.
        const doc = (
          await tx
            .select({
              connectionId: document.connectionId,
              externalId: document.externalId,
              externalStatus: document.externalStatus,
              bindingId: document.bindingId,
              sourcePath: document.sourcePath,
              filename: document.filename,
            })
            .from(document)
            .where(eq(document.entityId, input.documentId))
            .for('update')
        ).at(0)
        if (doc === undefined)
          return { _tag: 'refused', reason: FOLLOW_REFUSALS.missing }
        if (doc.connectionId === null || doc.externalId === null)
          return { _tag: 'refused', reason: FOLLOW_REFUSALS.notFromSource }
        if (doc.externalStatus === 'gone')
          return { _tag: 'refused', reason: FOLLOW_REFUSALS.gone }

        const connection = (
          await tx
            .select({
              provider: accountConnection.provider,
              status: accountConnection.status,
            })
            .from(accountConnection)
            .where(eq(accountConnection.id, doc.connectionId))
        ).at(0)
        if (connection === undefined || connection.status !== 'active')
          return { _tag: 'refused', reason: FOLLOW_REFUSALS.noConnection }

        if (doc.bindingId !== null) {
          const held = (
            await tx
              .select({ grain: storageBinding.grain })
              .from(storageBinding)
              .where(eq(storageBinding.id, doc.bindingId))
          ).at(0)
          if (held?.grain === 'folder')
            return { _tag: 'refused', reason: FOLLOW_REFUSALS.inFolder }
          // Its own file binding, unfollowed or stopped: follow it again.
          await tx
            .update(storageBinding)
            .set({ status: 'active', error: null, boundBy: input.userId })
            .where(eq(storageBinding.id, doc.bindingId))
          return { _tag: 'followed', bindingId: doc.bindingId }
        }

        const row = (
          await tx
            .insert(storageBinding)
            .values({
              connectionId: doc.connectionId,
              provider: connection.provider,
              grain: 'file',
              fileId: doc.externalId,
              folderPath: [doc.sourcePath, doc.filename]
                .filter((part) => part !== null)
                .join(' / '),
              targetEntityId: input.targetEntityId,
              direction: 'pull',
              boundBy: input.userId,
            })
            .returning({ id: storageBinding.id })
        ).at(0)
        if (row === undefined)
          throw new Error('storage_binding insert returned no row')
        await tx
          .update(document)
          .set({ bindingId: row.id })
          .where(eq(document.entityId, input.documentId))
        // Born `inherit`, so nothing rises; every binding write asks all the same.
        await raiseSensitivity(tx, { kind: 'binding', bindingId: row.id })
        return { _tag: 'followed', bindingId: row.id }
      }),
    )
    if (outcome._tag === 'refused')
      return yield* new BindingRefused({ reason: outcome.reason })
    return { bindingId: outcome.bindingId }
  },
)

/**
 * Unfollow: the document's file binding pauses, so the poll stops reading
 * it; the document, its binding id and every revision stay. False when the
 * document follows nothing live.
 */
export const unfollowFileProgram = Effect.fn('unfollowFileProgram')(function* (
  documentId: string,
): Effect.fn.Return<boolean, BindingStoreFailed> {
  const doc = (yield* query(() =>
    db
      .select({ bindingId: document.bindingId })
      .from(document)
      .where(eq(document.entityId, documentId)),
  )).at(0)
  if (doc === undefined || doc.bindingId === null) return false
  const bindingId = doc.bindingId
  const paused = yield* query(() =>
    db
      .update(storageBinding)
      .set({ status: 'paused' })
      .where(
        and(
          eq(storageBinding.id, bindingId),
          eq(storageBinding.grain, 'file'),
          inArray(storageBinding.status, ['active', 'error']),
        ),
      )
      .returning({ id: storageBinding.id }),
  )
  return paused.length > 0
})

/**
 * The provider deleted a file: the document held for it is marked gone,
 * and a file binding following it pauses. True when the document changed.
 */
export const goneAtProviderProgram = Effect.fn('goneAtProviderProgram')(
  function* (
    connectionId: string,
    externalId: string,
  ): Effect.fn.Return<boolean, BindingStoreFailed> {
    const marked = yield* markGoneProgram(connectionId, externalId)
    yield* query(() =>
      db
        .update(storageBinding)
        .set({ status: 'paused' })
        .where(
          and(
            eq(storageBinding.connectionId, connectionId),
            eq(storageBinding.grain, 'file'),
            eq(storageBinding.fileId, externalId),
            eq(storageBinding.status, 'active'),
          ),
        ),
    )
    return marked
  },
)

/**
 * A followed file's first read, before the change feed has said anything
 * about it: the bytes now at the provider against the row's. It may have
 * moved on since it was filed, and the feed may already have passed that
 * edit by while nothing followed it. Gone at the provider is a delete.
 */
export const catchUpFollowedProgram = Effect.fn('catchUpFollowedProgram')(
  function* (input: {
    readonly connectionId: string
    readonly held: HeldDocument
    readonly fileId: string
    readonly source: StorageSource
  }): Effect.fn.Return<
    ReviseOutcome | { readonly _tag: 'gone' },
    SyncFailure,
    Enqueue
  > {
    const file = yield* input.source
      .getFile(input.fileId)
      .pipe(Effect.catchTag('NotFound', () => Effect.succeed(null)))
    if (file === null) {
      yield* goneAtProviderProgram(input.connectionId, input.fileId)
      const gone: { readonly _tag: 'gone' } = { _tag: 'gone' }
      return gone
    }
    if (file.changeToken === input.held.externalRevisionId) {
      // Nothing to store: the bytes are left unread.
      yield* Effect.tryPromise(() => file.stream.cancel()).pipe(Effect.ignore)
      const unchanged: ReviseOutcome = { _tag: 'unchanged' }
      return unchanged
    }
    return yield* advanceToFileProgram(input.held, file)
  },
)

/** A document's revision ledger, newest first; null when there is no such document. */
export const documentRevisionsProgram = Effect.fn('documentRevisionsProgram')(
  function* (
    documentId: string,
  ): Effect.fn.Return<ReadonlyArray<RevisionRow> | null, BindingStoreFailed> {
    const doc = (yield* query(() =>
      db
        .select({
          createdAt: document.createdAt,
          externalRevisionId: document.externalRevisionId,
        })
        .from(document)
        .where(eq(document.entityId, documentId)),
    )).at(0)
    if (doc === undefined) return null
    const priors = yield* query(() =>
      db
        .select({
          externalRevisionId: documentRevision.externalRevisionId,
          at: documentRevision.at,
        })
        .from(documentRevision)
        .where(eq(documentRevision.documentId, documentId))
        .orderBy(asc(documentRevision.at), asc(documentRevision.id)),
    )
    return revisionLedger({
      createdAt: doc.createdAt.toISOString(),
      currentRevisionId: doc.externalRevisionId,
      priors: priors.map((p) => ({
        externalRevisionId: p.externalRevisionId,
        at: p.at.toISOString(),
      })),
    })
  },
)
