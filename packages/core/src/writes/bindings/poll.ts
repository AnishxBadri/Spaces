import { Effect } from 'effect'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection, entity, storageBinding } from '@spaces/db/schema'
import type { StorageEntry, StorageFolder, StorageSource } from '@spaces/sdk'
import type { ItemTarget } from '../../documents/resolve-item'
import { Enqueue } from '../../queue/enqueue'
import { QUEUES } from '../../queue/names'
import { BindingStoreFailed } from './bind'
import { markGoneProgram } from './gone'
import { isExport, moveHeldProgram } from './move'
import type { MoveOutcome } from './move'
import {
  heldDocumentOf,
  keepTokenProgram,
  reviseDocumentProgram,
} from './revise'
import { bindingFiler, markBindingFailedProgram } from './sync'
import type { HeldDocument } from './revise'
import type { BindingFiler, SyncBinding, SyncFailure } from './sync'

/**
 * The change poll: one `changes` pass per connection, fanned out to the
 * folder bindings it touches (docs/spec-storage-sources.md §8, first two rows).
 * - The cursor is the connection's (`storage_cursor`): one pass reads every
 *   drive the connection sees, so two bindings on one drive share it.
 * - The cursor advances only once the whole page is handled. A page cut
 *   short is replayed whole next time, and a file it already filed is held,
 *   so nothing is filed twice.
 * - A new file is filed; a held file a live binding brought is revised when
 *   its token moved (`reviseDocumentProgram`), and when it was renamed or
 *   moved inside its binding's subtree its path advances, with a re-file
 *   suggestion if the move crossed to another record (`moveHeldProgram`).
 * - A removal marks the held copy `gone`, and so does a move of a live
 *   binding's file out of every bound subtree: ours is kept, nothing is
 *   proposed (`markGoneProgram`). A `gone` file is never tracked again.
 * - A move into another binding's subtree is only revised, and a held file
 *   no live binding brought is left alone.
 */

/** A connection is polled once one of its bindings last synced this long ago. */
export const STORAGE_POLL_MIN_INTERVAL_MS = 10 * 60 * 1000

/** A folder binding the poll files for: active, with its folder and connection. */
export type PollBinding = SyncBinding & {
  readonly connectionId: string
  readonly folderId: string
}

/** One connection to poll: its cursor and its active folder bindings. */
export type PollConnection = {
  readonly connectionId: string
  readonly provider: string
  readonly cursor: string | null
  readonly bindings: ReadonlyArray<PollBinding>
}

/** What one connection's poll did with its page. */
export type PollTally = {
  readonly filed: number
  /** Filed meanwhile by a sync of the same file: claimed, not downloaded. */
  readonly held: number
  readonly attached: number
  /** Held files whose bytes advanced to a new revision. */
  readonly revised: number
  /** Held files renamed or moved inside their subtree: the path advanced. */
  readonly moved: number
  /** Moves that crossed to another record: a re-file suggestion each. */
  readonly proposed: number
  /** Held files deleted at the provider or moved out of every bound subtree. */
  readonly gone: number
  /**
   * A removal of nothing held, a folder, a held file with the token it
   * already has, one already `gone`, or one no live binding brought:
   * nothing to do.
   */
  readonly ignored: number
  /** A new file outside every bound subtree. */
  readonly outside: number
  readonly skipped: ReadonlyArray<{
    readonly name: string
    readonly reason: string
  }>
  /** Bindings whose target refused a filing: marked `error`, out of this poll. */
  readonly refused: ReadonlyArray<{
    readonly bindingId: string
    readonly reason: string
  }>
}

export type PollOutcome =
  /** No cursor yet: a starting one stored. The first sync did the backfill. */
  | { readonly _tag: 'started' }
  /**
   * The cursor expired: every binding re-synced and a fresh cursor stored,
   * unless a sync could not be sent — then the old one stays for the next tick.
   */
  | {
      readonly _tag: 'relisted'
      readonly resynced: number
      readonly stored: boolean
    }
  | { readonly _tag: 'polled'; readonly tally: PollTally }

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingStoreFailed({ cause }),
  })

/**
 * The connections with an active folder binding, each with every such
 * binding, kept when one of them is due: never synced, or last synced at
 * least `STORAGE_POLL_MIN_INTERVAL_MS` before `now`.
 */
export const dueStorageConnectionsProgram = Effect.fn(
  'dueStorageConnectionsProgram',
)(function* (
  now: Date,
): Effect.fn.Return<ReadonlyArray<PollConnection>, BindingStoreFailed> {
  const rows = yield* query(() =>
    db
      .select({
        id: storageBinding.id,
        connectionId: storageBinding.connectionId,
        provider: storageBinding.provider,
        folderId: storageBinding.folderId,
        folderPath: storageBinding.folderPath,
        targetEntityId: storageBinding.targetEntityId,
        targetKind: entity.kind,
        boundBy: storageBinding.boundBy,
        status: storageBinding.status,
        mapSubfolders: storageBinding.mapSubfolders,
        lastSyncedAt: storageBinding.lastSyncedAt,
        cursor: accountConnection.storageCursor,
      })
      .from(storageBinding)
      .innerJoin(entity, eq(entity.id, storageBinding.targetEntityId))
      .innerJoin(
        accountConnection,
        eq(accountConnection.id, storageBinding.connectionId),
      )
      .where(
        and(
          eq(storageBinding.status, 'active'),
          eq(storageBinding.grain, 'folder'),
          isNotNull(storageBinding.folderId),
        ),
      )
      .orderBy(storageBinding.createdAt),
  )
  const dueBefore = now.getTime() - STORAGE_POLL_MIN_INTERVAL_MS
  const byConnection = new Map<
    string,
    { connection: PollConnection; bindings: Array<PollBinding>; due: boolean }
  >()
  for (const { lastSyncedAt, cursor, ...row } of rows) {
    const { connectionId, folderId } = row
    if (connectionId === null || folderId === null) continue
    const group = byConnection.get(connectionId) ?? {
      connection: {
        connectionId,
        provider: row.provider,
        cursor,
        bindings: [],
      },
      bindings: [],
      due: false,
    }
    group.bindings.push({ ...row, connectionId, folderId })
    if (lastSyncedAt === null || lastSyncedAt.getTime() <= dueBefore)
      group.due = true
    byConnection.set(connectionId, group)
  }
  return [...byConnection.values()]
    .filter((g) => g.due)
    .map((g) => ({ ...g.connection, bindings: g.bindings }))
})

const storeCursor = (connectionId: string, cursor: string) =>
  query(() =>
    db
      .update(accountConnection)
      .set({ storageCursor: cursor })
      .where(eq(accountConnection.id, connectionId)),
  )

/** The bindings a finished poll brought up to date. */
const markPolled = (bindingIds: ReadonlyArray<string>) =>
  bindingIds.length === 0
    ? Effect.void
    : query(() =>
        db
          .update(storageBinding)
          .set({ lastSyncedAt: sql`now()` })
          .where(
            and(
              inArray(storageBinding.id, [...bindingIds]),
              eq(storageBinding.status, 'active'),
            ),
          ),
      )

/** A filing the binding's target refused: the binding is marked and leaves the poll. */
type Refused = { readonly _tag: 'refused'; readonly reason: string }

/** A folder inside a bound subtree: its binding and the folder names below the bound one. */
type Located = {
  readonly binding: PollBinding
  readonly names: ReadonlyArray<string>
}

/**
 * Re-list after an expired cursor: a fresh cursor first, so whatever changes
 * after it is the next poll's, then one sync per binding, then the store.
 */
const relist = Effect.fn('pollStorage.relist')(function* (
  connection: PollConnection,
  source: StorageSource,
) {
  const fresh = yield* source.changes(null)
  const enqueue = yield* Enqueue
  let sent = 0
  for (const binding of connection.bindings) {
    const id = yield* enqueue.enqueue(
      QUEUES.syncStorageBinding,
      { bindingId: binding.id },
      { singletonKey: binding.id },
    )
    if (id !== null) sent += 1
  }
  const stored = sent === connection.bindings.length
  if (stored) yield* storeCursor(connection.connectionId, fresh.next)
  const outcome: PollOutcome = {
    _tag: 'relisted',
    resynced: sent,
    stored,
  }
  return outcome
})

/**
 * One connection's poll. A new file's folder is placed by one `getFolder`
 * of its parent, cached for the poll along with every ancestor it names, so
 * a page of files in one folder costs one ancestry read.
 */
export const pollConnectionProgram = Effect.fn('pollConnectionProgram')(
  function* (input: {
    readonly connection: PollConnection
    readonly integrationId: string
    readonly source: StorageSource
  }): Effect.fn.Return<PollOutcome, SyncFailure, Enqueue> {
    const { connection, source } = input
    if (connection.cursor === null) {
      const start = yield* source.changes(null)
      yield* storeCursor(connection.connectionId, start.next)
      const started: PollOutcome = { _tag: 'started' }
      return started
    }
    const page = yield* source
      .changes(connection.cursor)
      .pipe(Effect.catchTag('CursorExpired', () => Effect.succeed(null)))
    if (page === null) return yield* relist(connection, source)

    // `bound` places folders and never shrinks; `live` loses a binding
    // refused mid-page, so a file under it is neither filed nor called gone.
    const bound = new Map<string, PollBinding>(
      connection.bindings.map((b) => [b.folderId, b]),
    )
    const live = new Map(bound)
    const located = new Map<string, Located | null>()
    const targets = new Map<string, ItemTarget>()
    const filers = new Map<string, BindingFiler>()
    const filerOf = (binding: PollBinding) => {
      const known = filers.get(binding.id)
      if (known !== undefined) return known
      const made = bindingFiler({
        binding,
        connectionId: connection.connectionId,
        integrationId: input.integrationId,
        source,
      })
      filers.set(binding.id, made)
      return made
    }

    /** Each folder of a chain, root first, placed against the bound folders. */
    const remember = (chain: ReadonlyArray<{ id: string; name: string }>) => {
      let at: Located | null = null
      for (const folder of chain) {
        const binding = bound.get(folder.id)
        if (binding !== undefined) at = { binding, names: [] }
        else if (at !== null)
          at = { binding: at.binding, names: [...at.names, folder.name] }
        located.set(folder.id, at)
      }
    }

    const locate = Effect.fn('pollStorage.locate')(function* (
      folderId: string,
    ) {
      const binding = bound.get(folderId)
      if (binding !== undefined) return { binding, names: [] }
      const known = located.get(folderId)
      if (known !== undefined) return known
      const folder = yield* source
        .getFolder(folderId)
        .pipe(
          Effect.catchTag('NotFound', () =>
            Effect.succeed<StorageFolder | null>(null),
          ),
        )
      if (folder === null) {
        located.set(folderId, null)
        return null
      }
      remember([...folder.parents, { id: folder.id, name: folder.name }])
      return located.get(folderId) ?? null
    })

    const targetOf = Effect.fn('pollStorage.targetOf')(function* (
      folderId: string,
      at: Located,
    ) {
      const known = targets.get(folderId)
      if (known !== undefined) return known
      const target = yield* filerOf(at.binding).targetOf(at.names)
      targets.set(folderId, target)
      return target
    })

    let filed = 0
    let held = 0
    let attached = 0
    let revised = 0
    let moved = 0
    let proposed = 0
    let gone = 0
    let ignored = 0
    let outside = 0
    const skipped: Array<{ name: string; reason: string }> = []
    const refused: Array<{ bindingId: string; reason: string }> = []

    /** Where a held file now sits, when that is inside its own binding. */
    const moveOf = Effect.fn('pollStorage.moveOf')(function* (
      doc: HeldDocument,
      entry: StorageEntry,
      binding: PollBinding,
      parentId: string,
      at: Located,
    ) {
      if (at.binding !== binding) return null
      const outcome: MoveOutcome = yield* moveHeldProgram({
        held: doc,
        entry,
        boundPath: binding.folderPath,
        targetOf: filerOf(binding).targetOf,
        target: yield* targetOf(parentId, at),
        sourcePath: [binding.folderPath, ...at.names].join(' / '),
        integrationId: input.integrationId,
      })
      return outcome
    })

    /** A held file: moved and revised only for a binding still live in this poll. */
    const heldFile = Effect.fn('pollStorage.heldFile')(function* (
      doc: HeldDocument,
      entry: StorageEntry,
    ) {
      const binding = [...live.values()].find((b) => b.id === doc.bindingId)
      if (doc.externalStatus === 'gone' || binding === undefined) {
        ignored += 1
        return
      }
      const parentId = entry.parentId
      const at = parentId === null ? null : yield* locate(parentId)
      // Out of every bound subtree: no new home to offer, so it is gone.
      if (parentId === null || at === null) {
        if (yield* markGoneProgram(connection.connectionId, entry.id)) gone += 1
        else ignored += 1
        return
      }
      const move = yield* moveOf(doc, entry, binding, parentId, at)
      if (move?._tag === 'moved') moved += 1
      if (move?._tag === 'proposed') proposed += 1
      // A renamed native document's new token is not an edit: its export
      // is never byte-stable, so reading it would mint a revision.
      const advanced = move !== null && move._tag !== 'unmoved'
      const outcome =
        advanced && isExport(doc, entry)
          ? yield* keepTokenProgram(doc, entry.changeToken)
          : yield* reviseDocumentProgram({ held: doc, entry, source })
      switch (outcome._tag) {
        case 'revised':
          revised += 1
          break
        case 'unchanged':
          ignored += 1
          break
        case 'skipped':
          skipped.push({ name: entry.name, reason: outcome.reason })
      }
    })

    const changedFile = Effect.fn('pollStorage.changedFile')(function* (
      entry: StorageEntry,
    ) {
      const doc = yield* heldDocumentOf(connection.connectionId, entry.id)
      if (doc !== null) return yield* heldFile(doc, entry)
      const at = entry.parentId === null ? null : yield* locate(entry.parentId)
      if (entry.parentId === null || at === null) {
        outside += 1
        return
      }
      // A binding refused earlier in this page is out of it.
      if (live.get(at.binding.folderId) !== at.binding) {
        ignored += 1
        return
      }
      const target = yield* targetOf(entry.parentId, at)
      const sourcePath = [at.binding.folderPath, ...at.names].join(' / ')
      const outcome = yield* filerOf(at.binding)
        .file(target, entry, sourcePath)
        .pipe(
          Effect.catchTag('DocumentBirthRejected', (e) =>
            markBindingFailedProgram(at.binding.id, e.reason).pipe(
              Effect.as<Refused>({ _tag: 'refused', reason: e.reason }),
            ),
          ),
        )
      switch (outcome._tag) {
        case 'filed':
          filed += 1
          break
        case 'held':
          held += 1
          break
        case 'attached':
          attached += 1
          break
        case 'gone':
          ignored += 1
          break
        case 'skipped':
          skipped.push({ name: entry.name, reason: outcome.reason })
          break
        case 'refused':
          live.delete(at.binding.folderId)
          refused.push({ bindingId: at.binding.id, reason: outcome.reason })
      }
    })

    for (const change of page.changes) {
      if (change._tag === 'removed') {
        if (yield* markGoneProgram(connection.connectionId, change.id))
          gone += 1
        else ignored += 1
        continue
      }
      if (change.entry.kind === 'folder') {
        ignored += 1
        continue
      }
      yield* changedFile(change.entry)
    }

    yield* storeCursor(connection.connectionId, page.next)
    yield* markPolled([...live.values()].map((b) => b.id))
    const polled: PollOutcome = {
      _tag: 'polled',
      tally: {
        filed,
        held,
        attached,
        revised,
        moved,
        proposed,
        gone,
        ignored,
        outside,
        skipped,
        refused,
      },
    }
    return polled
  },
)
