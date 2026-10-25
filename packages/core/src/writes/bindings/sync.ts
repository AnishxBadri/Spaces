import { Effect } from 'effect'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, link, storageBinding } from '@spaces/db/schema'
import type {
  AuthExpired,
  CursorExpired,
  NotFound,
  RateLimited,
  StorageEntry,
  StorageSource,
} from '@spaces/sdk'
import type { DocumentFilingTarget } from '../../documents/filing'
import { lookupFor, resolveItem } from '../../documents/resolve-item'
import type {
  CompanyDeal,
  CompanyMatch,
  FolderCandidate,
  FolderDecision,
  FolderLookups,
  ItemTarget,
} from '../../documents/resolve-item'
import { readableOf } from '../../documents/web-stream'
import type { Enqueue } from '../../queue/enqueue'
import { raiseSensitivity } from '../ai/stamp-sensitivity'
import { canonicalFileUrl } from '../connections/sources'
import { addEdges, DocumentBirthRejected } from '../documents/birth'
import type { DocumentActor, DocumentBirthFailed } from '../documents/birth'
import {
  documentIntakeMessage,
  intakeDocumentProgram,
} from '../documents/intake'
import type { DocumentIntakeFailed } from '../documents/intake'
import { previewResolveByName } from '../entities/resolve'
import { BindingStoreFailed, bindingTargetRefusalProgram } from './bind'
import { goneNot } from './gone'
import { filingTarget, moveHeldProgram } from './move'
import { isTombstoned } from './tombstone'
import type { MovableDocument, UnmappedFolder } from './move'

/**
 * A binding's sync: the bound folder's whole subtree walked through the
 * plugin's `StorageSource`, every file filed on the bound record.
 * The filing decision is here; the provider calls are the plugin's.
 * - Idempotent on (connection, external id), the unique index: a held file
 *   is claimed for the binding and filed, never downloaded again. Bindings
 *   cannot nest, so that key is (binding, external id) too.
 * - A file this binding already brought is never re-filed: its path advances
 *   and a crossing move is a suggestion (`moveHeldProgram`), as in the poll.
 * - A held file marked `gone` is never claimed, moved or flipped back to
 *   `linked`: it stopped tracking for good (`markGoneProgram`).
 * - A file deleted in the app is tombstoned for its binding and never
 *   filed again by it (`tombstoneDocument`), so a re-list resurrects nothing.
 * - Bytes go through intake, so a sha already filed on the target attaches.
 * - With `map_subfolders` on, each folder's target is `resolveItem`'s answer
 *   to the lookups made here; off, every file lands on the bound record.
 */

/** A binding as its sync reads it. */
export type SyncBinding = {
  readonly id: string
  readonly connectionId: string | null
  readonly provider: string
  readonly folderId: string | null
  readonly folderPath: string
  readonly targetEntityId: string
  readonly targetKind: string
  readonly boundBy: string | null
  readonly status: 'active' | 'error' | 'paused'
  readonly mapSubfolders: boolean
}

/** What one sync did, file by file. */
export type SyncTally = {
  /** Born from this sync's download. */
  readonly filed: number
  /** Already held for this connection: claimed and filed, not downloaded. */
  readonly held: number
  /** Same bytes already on the target: attached, not duplicated. */
  readonly attached: number
  /** Held, but `gone`: listed again, left untracked. */
  readonly gone: number
  /** Deleted in the app: tombstoned for this binding, not filed again. */
  readonly tombstoned: number
  /**
   * Refused one by one (too large, vanished, a record the folder maps to
   * would not take it): the walk went on.
   */
  readonly skipped: ReadonlyArray<{
    readonly name: string
    readonly reason: string
  }>
  /**
   * Folders whose name came close to a company and matched none exactly:
   * their files stayed on the parent target. Only folders that held a file.
   */
  readonly unmapped: ReadonlyArray<UnmappedFolder>
}

/**
 * Fails the whole walk: the provider's, or ours. A `DocumentBirthRejected`
 * here is the bound record itself gone or not bindable; one file's refusal
 * is a skip.
 */
export type SyncFailure =
  | NotFound
  | AuthExpired
  | RateLimited
  | CursorExpired
  | DocumentBirthRejected
  | DocumentBirthFailed
  | DocumentIntakeFailed
  | BindingStoreFailed

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingStoreFailed({ cause }),
  })

/** The binding and its target's kind; null once it is unlinked. */
export const syncBindingOf = Effect.fn('syncBindingOf')(function* (
  bindingId: string,
): Effect.fn.Return<SyncBinding | null, BindingStoreFailed> {
  const row = (yield* query(() =>
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
      })
      .from(storageBinding)
      .innerJoin(entity, eq(entity.id, storageBinding.targetEntityId))
      .where(eq(storageBinding.id, bindingId)),
  )).at(0)
  return row ?? null
})

/** The record a binding files on, or null once it is unlinked: where its runs show. */
export async function bindingTargetOf(
  bindingId: string,
): Promise<string | null> {
  const row = (
    await db
      .select({ id: storageBinding.targetEntityId })
      .from(storageBinding)
      .where(eq(storageBinding.id, bindingId))
  ).at(0)
  return row?.id ?? null
}

/** A finished sync: active, no error, synced now. */
export const markBindingSyncedProgram = Effect.fn('markBindingSyncedProgram')(
  function* (bindingId: string): Effect.fn.Return<void, BindingStoreFailed> {
    yield* query(() =>
      db
        .update(storageBinding)
        .set({ status: 'active', error: null, lastSyncedAt: sql`now()` })
        .where(eq(storageBinding.id, bindingId)),
    )
  },
)

/** A sync that cannot go on: `error`, with the sentence why. Nothing filed is touched. */
export const markBindingFailedProgram = Effect.fn('markBindingFailedProgram')(
  function* (
    bindingId: string,
    error: string,
  ): Effect.fn.Return<void, BindingStoreFailed> {
    yield* query(() =>
      db
        .update(storageBinding)
        .set({ status: 'error', error: error.slice(0, 1000) })
        .where(eq(storageBinding.id, bindingId)),
    )
  },
)

type Walk = {
  readonly binding: SyncBinding
  readonly connectionId: string
  readonly integrationId: string
  readonly source: StorageSource
  readonly actor: DocumentActor
  readonly userId: string | null
  readonly targetOf: (
    names: ReadonlyArray<string>,
  ) => Effect.Effect<ItemTarget, BindingStoreFailed>
}

/**
 * One file's filing: born, claimed from a held copy, attached by sha, left
 * alone because its held copy is `gone` or it was deleted in the app, or
 * refused.
 */
export type FileOutcome =
  | {
      readonly _tag: 'filed' | 'held' | 'attached' | 'gone'
      readonly documentId: string
    }
  | { readonly _tag: 'tombstoned' }
  | { readonly _tag: 'skipped'; readonly reason: string }

type HeldRow = MovableDocument & {
  readonly bindingId: string | null
  readonly externalStatus: 'linked' | 'gone' | null
}

const heldDocument = (connectionId: string, externalId: string) =>
  query(
    async (): Promise<HeldRow | null> =>
      (
        await db
          .select({
            id: document.entityId,
            bindingId: document.bindingId,
            externalStatus: document.externalStatus,
            sourcePath: document.sourcePath,
            filename: document.filename,
            mime: document.mime,
          })
          .from(document)
          .where(
            and(
              eq(document.connectionId, connectionId),
              eq(document.externalId, externalId),
            ),
          )
      ).at(0) ?? null,
  )

/**
 * A held document joins this binding and its target. One another binding
 * already claims is left where it is.
 */
const claimHeld = (
  walk: Walk,
  target: DocumentFilingTarget,
  documentId: string,
  sourcePath: string,
) =>
  query(() =>
    db.transaction(async (tx) => {
      const claimed = await tx
        .update(document)
        .set({
          bindingId: walk.binding.id,
          sourcePath,
          externalStatus: 'linked',
        })
        .where(
          and(
            eq(document.entityId, documentId),
            or(
              isNull(document.bindingId),
              eq(document.bindingId, walk.binding.id),
            ),
            goneNot,
          ),
        )
        .returning({ id: document.entityId })
      if (claimed.length > 0)
        await addEdges(tx, documentId, [target], walk.userId)
    }),
  )

/**
 * Same bytes were already on the target: that document is this file's copy,
 * unless it already came from somewhere else. A sensitive binding stamps it
 * in the same transaction, as a claim does.
 */
const stampAttached = (
  walk: Walk,
  documentId: string,
  entry: StorageEntry,
  changeToken: string,
  sourcePath: string,
) =>
  query(() =>
    db.transaction(async (tx) => {
      const stamped = await tx
        .update(document)
        .set({
          bindingId: walk.binding.id,
          connectionId: walk.connectionId,
          externalId: entry.id,
          externalUrl: canonicalFileUrl(walk.binding.provider, entry.id),
          externalStatus: 'linked',
          externalRevisionId: changeToken,
          sourcePath,
        })
        .where(
          and(
            eq(document.entityId, documentId),
            isNull(document.externalId),
            goneNot,
          ),
        )
        .returning({ id: document.entityId })
      if (stamped.length > 0)
        await raiseSensitivity(tx, { kind: 'bound', entityId: documentId })
    }),
  )

const fileEntry = Effect.fn('syncBinding.fileEntry')(function* (
  walk: Walk,
  folder: ItemTarget,
  entry: StorageEntry,
  sourcePath: string,
): Effect.fn.Return<FileOutcome, SyncFailure, Enqueue> {
  const target = filingTarget(folder)
  const held = yield* heldDocument(walk.connectionId, entry.id)
  if (held?.externalStatus === 'gone')
    return { _tag: 'gone', documentId: held.id }
  // This binding's own file is never re-filed by a walk: a move is the
  // poll's rule, a path that advances and at most a suggestion.
  if (held?.bindingId === walk.binding.id) {
    yield* moveHeldProgram({
      held,
      entry,
      boundPath: walk.binding.folderPath,
      targetOf: walk.targetOf,
      target: folder,
      sourcePath,
      integrationId: walk.integrationId,
    })
    return { _tag: 'held', documentId: held.id }
  }
  if (held !== null) {
    yield* claimHeld(walk, target, held.id, sourcePath)
    return { _tag: 'held', documentId: held.id }
  }

  if (yield* query(() => isTombstoned(walk.binding.id, entry.id)))
    return { _tag: 'tombstoned' }

  const file = yield* walk.source
    .getFile(entry.id)
    .pipe(Effect.catchTag('NotFound', () => Effect.succeed(null)))
  if (file === null)
    return { _tag: 'skipped', reason: 'gone before it was read' }
  const decided = resolveItem({ kind: 'file', name: file.name }, folder)

  const born = yield* intakeDocumentProgram({
    stream: readableOf(file.stream),
    filename: file.name,
    mime: file.mime,
    declaredSize: entry.size,
    kind: decided.documentKind,
    sourceClass: 'integration',
    sourceRef: walk.integrationId,
    provenance: {
      sourcePath,
      externalId: entry.id,
      externalUrl: canonicalFileUrl(walk.binding.provider, entry.id),
      externalStatus: 'linked',
      connectionId: walk.connectionId,
      bindingId: walk.binding.id,
      // The token the bytes were read at, which may be newer than the entry's.
      externalRevisionId: file.changeToken,
    },
    fileAgainst: [target],
    actor: walk.actor,
  }).pipe(
    Effect.map((b) => ({ ...b, raced: false })),
    Effect.catchTag('DocumentTooLarge', (e) =>
      Effect.succeed({ skipped: documentIntakeMessage(e) }),
    ),
    // A concurrent filing of this file won the unique (connection, external
    // id): claim the winner.
    Effect.catchTag('DocumentBirthFailed', (e) =>
      heldDocument(walk.connectionId, entry.id).pipe(
        Effect.flatMap((winner) =>
          winner === null
            ? Effect.fail(e)
            : Effect.succeed({ id: winner.id, deduped: false, raced: true }),
        ),
      ),
    ),
  )
  if ('skipped' in born) return { _tag: 'skipped', reason: born.skipped }
  if (born.raced) {
    yield* claimHeld(walk, target, born.id, sourcePath)
    return { _tag: 'held', documentId: born.id }
  }
  if (born.deduped) {
    yield* stampAttached(walk, born.id, entry, file.changeToken, sourcePath)
    return { _tag: 'attached', documentId: born.id }
  }
  return { _tag: 'filed', documentId: born.id }
})

/** Every page of one folder's direct children. */
const listAll = Effect.fn('syncBinding.listAll')(function* (
  source: StorageSource,
  folderId: string,
) {
  const entries: Array<StorageEntry> = []
  let cursor: string | undefined
  do {
    const page = yield* source.listFolder(
      folderId,
      cursor === undefined ? {} : { cursor },
    )
    entries.push(...page.entries)
    cursor = page.next
  } while (cursor !== undefined)
  return entries
})

/** The bound record as `resolveItem` reads it. */
const rootTarget = (binding: SyncBinding): ItemTarget => ({
  entityKind:
    binding.targetKind === 'space' ||
    binding.targetKind === 'company' ||
    binding.targetKind === 'deal'
      ? binding.targetKind
      : 'record',
  entityId: binding.targetEntityId,
  documentKind: null,
})

/** A folder name against the companies, match-only: nothing is created. */
const companyMatch = (name: string) =>
  query(() => previewResolveByName({ kind: 'company', name })).pipe(
    Effect.map((found): CompanyMatch => {
      if (found.verdict === 'attach')
        return { verdict: 'attach', entityId: found.entityId }
      if (found.verdict === 'fuzzy')
        return { verdict: 'fuzzy', candidates: found.candidates }
      return { verdict: 'no_match' }
    }),
  )

/** A company's live deals, by their `company` reference. */
const dealsOf = (companyId: string) =>
  query((): Promise<Array<CompanyDeal>> =>
    db
      .select({ entityId: entity.id, name: entity.canonicalName })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, companyId),
          eq(link.relation, 'references'),
          eq(link.attrSlug, 'company'),
          eq(entity.kind, 'deal'),
          isNull(entity.mergedIntoId),
        ),
      ),
  )

/**
 * One binding's filing, shared by the walk and the change poll: where a
 * folder under the bound one files, and one file filed there.
 * - `descend` is one `resolveItem` step; `targetOf` folds it over the folder
 *   names from the bound folder down, so a file the poll finds deep in the
 *   subtree lands where the walk would have put it.
 * - A company's deals are read once per filer.
 */
export type BindingFiler = {
  readonly binding: SyncBinding
  /** The bound record as `resolveItem` reads it. */
  readonly root: ItemTarget
  readonly descend: (
    parent: ItemTarget,
    name: string,
  ) => Effect.Effect<FolderDecision, BindingStoreFailed>
  readonly targetOf: (
    names: ReadonlyArray<string>,
  ) => Effect.Effect<ItemTarget, BindingStoreFailed>
  readonly file: (
    folder: ItemTarget,
    entry: StorageEntry,
    sourcePath: string,
  ) => Effect.Effect<FileOutcome, SyncFailure, Enqueue>
}

export const bindingFiler = (input: {
  readonly binding: SyncBinding
  readonly connectionId: string
  readonly integrationId: string
  readonly source: StorageSource
}): BindingFiler => {
  const { binding } = input
  const deals = new Map<string, ReadonlyArray<CompanyDeal>>()

  const lookups = Effect.fn('syncBinding.lookups')(function* (
    parent: ItemTarget,
    name: string,
  ): Effect.fn.Return<FolderLookups, BindingStoreFailed> {
    const needed = lookupFor(parent, binding.mapSubfolders)
    if (needed === 'company')
      return { lookup: 'company', company: yield* companyMatch(name) }
    if (needed === 'deals') {
      const known =
        deals.get(parent.entityId) ?? (yield* dealsOf(parent.entityId))
      deals.set(parent.entityId, known)
      return { lookup: 'deals', deals: known }
    }
    return { lookup: 'none' }
  })

  const descend = Effect.fn('syncBinding.descend')(function* (
    parent: ItemTarget,
    name: string,
  ): Effect.fn.Return<FolderDecision, BindingStoreFailed> {
    return resolveItem({ kind: 'folder', name }, parent, {
      mapSubfolders: binding.mapSubfolders,
      lookups: yield* lookups(parent, name),
    })
  })

  const root = rootTarget(binding)
  const targetOf = Effect.fn('syncBinding.targetOf')(function* (
    names: ReadonlyArray<string>,
  ): Effect.fn.Return<ItemTarget, BindingStoreFailed> {
    let target = root
    for (const name of names) target = (yield* descend(target, name)).target
    return target
  })
  const walk: Walk = {
    ...input,
    actor:
      binding.boundBy === null
        ? { integrationId: input.integrationId }
        : { userId: binding.boundBy },
    userId: binding.boundBy,
    targetOf,
  }

  /**
   * A refused filing skips the file, unless the bound record itself is gone
   * or not bindable: then the refusal is that sentence and fails the walk.
   */
  const file = (folder: ItemTarget, entry: StorageEntry, sourcePath: string) =>
    fileEntry(walk, folder, entry, sourcePath).pipe(
      Effect.catchTag('DocumentBirthRejected', (rejected) =>
        bindingTargetRefusalProgram(binding.targetEntityId).pipe(
          Effect.flatMap((refusal) =>
            refusal === null
              ? Effect.succeed<FileOutcome>({
                  _tag: 'skipped',
                  reason: rejected.reason,
                })
              : Effect.fail(new DocumentBirthRejected({ reason: refusal })),
          ),
        ),
      ),
    )

  return { binding, root, descend, targetOf, file }
}

/** A folder left on its parent with close companies, reported once it holds a file. */
type Unmapped = {
  readonly folderPath: string
  readonly from: ItemTarget
  readonly candidates: ReadonlyArray<FolderCandidate>
  readonly documentIds: Array<string>
  reported: boolean
}

type Queued = {
  readonly id: string
  readonly path: string
  readonly target: ItemTarget
  readonly unmapped: Unmapped | null
}

/**
 * The walk, breadth first from the bound folder: each file filed as it is
 * reached, so a walk cut short keeps what it filed and a re-run picks up the
 * rest. `source_path` is the file's folder path, rooted at the binding's.
 * - The bound folder gone fails the walk; a subfolder gone mid-walk is skipped.
 * - An empty folder creates nothing: lookups only read, and only files file.
 */
export const syncBindingProgram = Effect.fn('syncBindingProgram')(
  function* (input: {
    readonly binding: SyncBinding
    readonly connectionId: string
    readonly folderId: string
    readonly integrationId: string
    readonly source: StorageSource
  }): Effect.fn.Return<SyncTally, SyncFailure, Enqueue> {
    const { binding } = input
    const filer = bindingFiler(input)
    let filed = 0
    let held = 0
    let attached = 0
    let gone = 0
    let tombstoned = 0
    const skipped: Array<{ name: string; reason: string }> = []
    const unmapped: Array<Unmapped> = []

    const queue: Array<Queued> = [
      {
        id: input.folderId,
        path: binding.folderPath,
        target: filer.root,
        unmapped: null,
      },
    ]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const folder = next
      const entries = yield* listAll(input.source, folder.id).pipe(
        Effect.catchTag('NotFound', (e) =>
          folder.id === input.folderId
            ? Effect.fail(e)
            : Effect.succeed<ReadonlyArray<StorageEntry>>([]),
        ),
      )
      for (const entry of entries) {
        if (entry.kind === 'folder') {
          const path = `${folder.path} / ${entry.name}`
          const decided = yield* filer.descend(folder.target, entry.name)
          queue.push({
            id: entry.id,
            path,
            target: decided.target,
            unmapped:
              decided.candidates.length > 0
                ? {
                    folderPath: path,
                    from: decided.target,
                    candidates: decided.candidates,
                    documentIds: [],
                    reported: false,
                  }
                : decided.target.entityId === folder.target.entityId
                  ? folder.unmapped
                  : null,
          })
          continue
        }
        if (folder.unmapped !== null && !folder.unmapped.reported) {
          folder.unmapped.reported = true
          unmapped.push(folder.unmapped)
        }
        const outcome = yield* filer.file(folder.target, entry, folder.path)
        if (
          (outcome._tag === 'filed' ||
            outcome._tag === 'held' ||
            outcome._tag === 'attached') &&
          folder.unmapped !== null
        )
          folder.unmapped.documentIds.push(outcome.documentId)
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
            gone += 1
            break
          case 'tombstoned':
            tombstoned += 1
            break
          case 'skipped':
            skipped.push({ name: entry.name, reason: outcome.reason })
        }
      }
    }
    return {
      filed,
      held,
      attached,
      gone,
      tombstoned,
      skipped,
      unmapped: unmapped.map(({ reported: _, ...u }) => u),
    }
  },
)
