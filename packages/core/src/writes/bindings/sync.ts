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
  FolderLookups,
  ItemTarget,
} from '../../documents/resolve-item'
import { readableOf } from '../../documents/web-stream'
import type { Enqueue } from '../../queue/enqueue'
import { canonicalFileUrl } from '../connections/sources'
import { addEdges } from '../documents/birth'
import type {
  DocumentActor,
  DocumentBirthFailed,
  DocumentBirthRejected,
} from '../documents/birth'
import {
  documentIntakeMessage,
  intakeDocumentProgram,
} from '../documents/intake'
import type { DocumentIntakeFailed } from '../documents/intake'
import { previewResolveByName } from '../entities/resolve'
import { BindingStoreFailed } from './bind'

/**
 * A binding's sync: the bound folder's whole subtree walked through the
 * plugin's `StorageSource`, every file filed on the bound record (§5.2).
 * The filing decision is here; the provider calls are the plugin's.
 * - Idempotent on (connection, external id), the unique index: a held file
 *   is claimed for the binding and filed, never downloaded again. Bindings
 *   cannot nest, so that key is (binding, external id) too.
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
  /** Refused one by one (too large, vanished): the walk went on. */
  readonly skipped: ReadonlyArray<{
    readonly name: string
    readonly reason: string
  }>
  /**
   * Folders whose name came close to a company and matched none exactly:
   * their files stayed on the parent target. Only folders that held a file.
   */
  readonly unmapped: ReadonlyArray<{
    readonly folderPath: string
    readonly candidates: ReadonlyArray<FolderCandidate>
  }>
}

/** Fails the whole walk: the provider's, or ours. */
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
}

type FileOutcome =
  | { readonly _tag: 'filed' | 'held' | 'attached' }
  | { readonly _tag: 'skipped'; readonly reason: string }

const heldDocument = (connectionId: string, externalId: string) =>
  query(
    async () =>
      (
        await db
          .select({ id: document.entityId })
          .from(document)
          .where(
            and(
              eq(document.connectionId, connectionId),
              eq(document.externalId, externalId),
            ),
          )
      ).at(0)?.id ?? null,
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
          ),
        )
        .returning({ id: document.entityId })
      if (claimed.length > 0)
        await addEdges(tx, documentId, [target], walk.userId)
    }),
  )

/**
 * Same bytes were already on the target: that document is this file's copy,
 * unless it already came from somewhere else.
 */
const stampAttached = (
  walk: Walk,
  documentId: string,
  entry: StorageEntry,
  sourcePath: string,
) =>
  query(() =>
    db
      .update(document)
      .set({
        bindingId: walk.binding.id,
        connectionId: walk.connectionId,
        externalId: entry.id,
        externalUrl: canonicalFileUrl(walk.binding.provider, entry.id),
        externalStatus: 'linked',
        sourcePath,
      })
      .where(
        and(eq(document.entityId, documentId), isNull(document.externalId)),
      ),
  )

const fileEntry = Effect.fn('syncBinding.fileEntry')(function* (
  walk: Walk,
  folder: ItemTarget,
  entry: StorageEntry,
  sourcePath: string,
): Effect.fn.Return<FileOutcome, SyncFailure, Enqueue> {
  const target = filingTarget(folder)
  const held = yield* heldDocument(walk.connectionId, entry.id)
  if (held !== null) {
    yield* claimHeld(walk, target, held, sourcePath)
    return { _tag: 'held' }
  }

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
            : Effect.succeed({ id: winner, deduped: false, raced: true }),
        ),
      ),
    ),
  )
  if ('skipped' in born) return { _tag: 'skipped', reason: born.skipped }
  if (born.raced) {
    yield* claimHeld(walk, target, born.id, sourcePath)
    return { _tag: 'held' }
  }
  if (born.deduped) {
    yield* stampAttached(walk, born.id, entry, sourcePath)
    return { _tag: 'attached' }
  }
  return { _tag: 'filed' }
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

/** Where a target's documents are filed: a space by `entity_space`, else `tagged_in`. */
const filingTarget = (target: ItemTarget): DocumentFilingTarget => ({
  kind: target.entityKind === 'space' ? 'space' : 'record',
  entityId: target.entityId,
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

/** A folder left on its parent with close companies, reported once it holds a file. */
type Unmapped = {
  readonly folderPath: string
  readonly candidates: ReadonlyArray<FolderCandidate>
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
    const walk: Walk = {
      ...input,
      actor:
        binding.boundBy === null
          ? { integrationId: input.integrationId }
          : { userId: binding.boundBy },
      userId: binding.boundBy,
    }
    let filed = 0
    let held = 0
    let attached = 0
    const skipped: Array<{ name: string; reason: string }> = []
    const unmapped: Array<{
      folderPath: string
      candidates: ReadonlyArray<FolderCandidate>
    }> = []
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

    const queue: Array<Queued> = [
      {
        id: input.folderId,
        path: binding.folderPath,
        target: rootTarget(binding),
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
          const decided = resolveItem(
            { kind: 'folder', name: entry.name },
            folder.target,
            {
              mapSubfolders: binding.mapSubfolders,
              lookups: yield* lookups(folder.target, entry.name),
            },
          )
          queue.push({
            id: entry.id,
            path,
            target: decided.target,
            unmapped:
              decided.candidates.length > 0
                ? {
                    folderPath: path,
                    candidates: decided.candidates,
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
          unmapped.push({
            folderPath: folder.unmapped.folderPath,
            candidates: folder.unmapped.candidates,
          })
        }
        const outcome = yield* fileEntry(
          walk,
          folder.target,
          entry,
          folder.path,
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
          case 'skipped':
            skipped.push({ name: entry.name, reason: outcome.reason })
        }
      }
    }
    return { filed, held, attached, skipped, unmapped }
  },
)
