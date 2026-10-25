import { Effect } from 'effect'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, entitySpace, link } from '@spaces/db/schema'
import type { StorageEntry } from '@spaces/sdk'
import type { DocumentFilingTarget } from '../../documents/filing'
import type { FolderCandidate, ItemTarget } from '../../documents/resolve-item'
import { raiseSensitivity } from '../ai/stamp-sensitivity'
import { proposeWith } from '../suggestions/propose'
import type { Reader } from '../suggestions/propose'
import { BindingStoreFailed } from './bind'
import { goneNot } from './gone'

/**
 * A held file renamed or moved inside its bound subtree, or
 * into another binding's subtree on the same connection.
 * - The path and the name advance in place: no edge, no new document, no
 *   extraction. Moved under another binding, `binding_id` follows the folder.
 * - When the new folder resolves to another record than the old one did,
 *   the outcome is a `refile_document` suggestion naming both, never a
 *   silent re-file. A person's accept moves the edge.
 * - The old target is the stored `source_path` folded through the same
 *   `resolveItem` steps as the new one, so a move between two folders of
 *   one company proposes nothing.
 * - A `gone` row is left alone: it stopped tracking (`markGoneProgram`).
 */

/** A held document as a move compares it. */
export type MovableDocument = {
  readonly id: string
  readonly sourcePath: string | null
  readonly filename: string | null
  readonly mime: string | null
}

export type MoveOutcome =
  /** Same folder, same name. */
  | { readonly _tag: 'unmoved' }
  /** Path or name advanced; the filing stands. */
  | { readonly _tag: 'moved' }
  /** Path advanced, and a re-file proposed. */
  | { readonly _tag: 'proposed' }

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingStoreFailed({ cause }),
  })

/** Where a target's documents are filed: a space by `entity_space`, else `tagged_in`. */
export const filingTarget = (target: ItemTarget): DocumentFilingTarget => ({
  kind: target.entityKind === 'space' ? 'space' : 'record',
  entityId: target.entityId,
})

/**
 * The folder names below the bound folder in a stored `source_path`, or
 * null when the path is not under it. A folder name holding " / " splits
 * wrong; the path is a label, so the fold then lands on a nearer folder.
 */
export const folderNamesUnder = (
  boundPath: string,
  sourcePath: string | null,
): ReadonlyArray<string> | null => {
  if (sourcePath === null) return null
  if (sourcePath === boundPath) return []
  const prefix = `${boundPath} / `
  return sourcePath.startsWith(prefix)
    ? sourcePath.slice(prefix.length).split(' / ')
    : null
}

/**
 * A native document held as its export: the listing has no size and a mime
 * other than the bytes we keep. Its export is never byte-stable.
 */
export const isExport = (held: MovableDocument, entry: StorageEntry) =>
  entry.size === null && held.mime !== null && held.mime !== entry.mime

const extensionOf = (name: string | null) => {
  if (name === null) return ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

/**
 * The filename the entry now implies, or null when it is the one held. An
 * export keeps the extension it was stored under (`Memo` → `Memo.docx`).
 */
export const renamedTo = (
  held: MovableDocument,
  entry: StorageEntry,
): string | null => {
  const ext = isExport(held, entry) ? extensionOf(held.filename) : ''
  const name =
    ext !== '' && !entry.name.toLowerCase().endsWith(ext.toLowerCase())
      ? `${entry.name}${ext}`
      : entry.name
  return name === held.filename ? null : name
}

/** Whether the document is filed on the target, by the target's edge kind. */
const filedOn = async (
  reader: Reader,
  documentId: string,
  target: DocumentFilingTarget,
) =>
  target.kind === 'space'
    ? (
        await reader
          .select({ id: entitySpace.entityId })
          .from(entitySpace)
          .where(
            and(
              eq(entitySpace.entityId, documentId),
              eq(entitySpace.spaceId, target.entityId),
            ),
          )
      ).length > 0
    : (
        await reader
          .select({ id: link.id })
          .from(link)
          .where(
            and(
              eq(link.fromEntityId, documentId),
              eq(link.toEntityId, target.entityId),
              eq(link.relation, 'tagged_in'),
            ),
          )
      ).length > 0

/** One proposed re-file of one document. */
export type RefileProposal = {
  readonly documentId: string
  readonly from: ItemTarget
  readonly to: ItemTarget
  readonly sourcePath: string
  readonly rationale: string
  readonly integrationId: string
}

/**
 * Propose moving a document's filing, on `reader`. Nothing is proposed when
 * the document already left `from` or already sits on `to`: either a person
 * decided, or there is nothing to move. True when a row was proposed or
 * one is already held for this move.
 */
export async function proposeRefileWith(
  reader: Reader,
  input: RefileProposal,
): Promise<boolean> {
  const { documentId } = input
  if (input.from.entityId === input.to.entityId) return false
  if (!(await filedOn(reader, documentId, filingTarget(input.from))))
    return false
  if (await filedOn(reader, documentId, filingTarget(input.to))) return false
  const names = new Map(
    (
      await reader
        .select({ id: entity.id, name: entity.canonicalName })
        .from(entity)
        .where(
          inArray(entity.id, [
            documentId,
            input.from.entityId,
            input.to.entityId,
          ]),
        )
    ).map((r) => [r.id, r.name]),
  )
  const name = (id: string) => names.get(id) ?? 'Untitled'
  await proposeWith(reader, {
    entityId: documentId,
    kind: 'refile_document',
    payload: {
      documentId,
      fromEntityId: input.from.entityId,
      toEntityId: input.to.entityId,
      sourcePath: input.sourcePath,
      documentName: name(documentId),
      fromName: name(input.from.entityId),
      toName: name(input.to.entityId),
    },
    rationale: input.rationale,
    proposedBy: { type: 'integration', id: input.integrationId },
  })
  return true
}

/**
 * One held file against where its provider now lists it. The path and the
 * name advance by compare-and-set on what was read, so a replayed page or a
 * racing poll advances once; a re-file is proposed in the same transaction,
 * so a page cut short after it replays to the same proposal.
 */
export const moveHeldProgram = Effect.fn('moveHeldProgram')(function* (input: {
  readonly held: MovableDocument
  readonly entry: StorageEntry
  /** The bound folder's path, which every `source_path` it filed starts with. */
  readonly boundPath: string
  /** The binding's fold from folder names to a target (`BindingFiler.targetOf`). */
  readonly targetOf: (
    names: ReadonlyArray<string>,
  ) => Effect.Effect<ItemTarget, BindingStoreFailed>
  /** Where the file's folder resolves now, and its path. */
  readonly target: ItemTarget
  readonly sourcePath: string
  readonly integrationId: string
  /**
   * The file now sits under another binding: `boundPath` and `targetOf` are
   * still the one that brought it, so the old target folds as before, and
   * `target` is the new binding's.
   */
  readonly rebind?: { readonly from: string; readonly to: string }
}): Effect.fn.Return<MoveOutcome, BindingStoreFailed> {
  const { held, sourcePath, rebind } = input
  const name = renamedTo(held, input.entry)
  const moved = held.sourcePath !== sourcePath || rebind !== undefined
  if (!moved && name === null) return { _tag: 'unmoved' }

  const before = moved
    ? folderNamesUnder(input.boundPath, held.sourcePath)
    : null
  const from = before === null ? null : yield* input.targetOf(before)
  const refile =
    from === null || from.entityId === input.target.entityId
      ? null
      : {
          documentId: held.id,
          from,
          to: input.target,
          sourcePath,
          rationale: `Moved in the source from ${held.sourcePath ?? 'its folder'} to ${sourcePath}`,
          integrationId: input.integrationId,
        }

  return yield* query(() =>
    db.transaction(async (tx): Promise<MoveOutcome> => {
      const advanced = await tx
        .update(document)
        .set({
          sourcePath,
          ...(name === null ? {} : { filename: name }),
          ...(rebind === undefined ? {} : { bindingId: rebind.to }),
        })
        .where(
          and(
            eq(document.entityId, held.id),
            sql`${document.sourcePath} is not distinct from ${held.sourcePath}`,
            sql`${document.filename} is not distinct from ${held.filename}`,
            rebind === undefined
              ? undefined
              : eq(document.bindingId, rebind.from),
            goneNot,
          ),
        )
        .returning({ id: document.entityId })
      if (advanced.length === 0) return { _tag: 'unmoved' }
      // A sensitive new binding raises the file's chunks, as a claim does.
      if (rebind !== undefined)
        await raiseSensitivity(tx, { kind: 'bound', entityId: held.id })
      // The record's name follows the file's unless a person renamed it.
      if (name !== null && held.filename !== null)
        await tx
          .update(entity)
          .set({ canonicalName: name })
          .where(
            and(
              eq(entity.id, held.id),
              eq(entity.canonicalName, held.filename),
            ),
          )
      if (refile !== null && (await proposeRefileWith(tx, refile)))
        return { _tag: 'proposed' }
      return { _tag: 'moved' }
    }),
  )
})

/** A folder the walk left on its parent, with close companies and the files it filed there. */
export type UnmappedFolder = {
  readonly folderPath: string
  readonly from: ItemTarget
  readonly candidates: ReadonlyArray<FolderCandidate>
  readonly documentIds: ReadonlyArray<string>
}

/**
 * A near-missed folder's files, each proposed to the closest company, the
 * other candidates named in the rationale. One suggestion per document: the
 * accept moves one document's edge. Returns how many are held open.
 */
export const proposeUnmappedProgram = Effect.fn('proposeUnmappedProgram')(
  function* (
    unmapped: ReadonlyArray<UnmappedFolder>,
    integrationId: string,
  ): Effect.fn.Return<number, BindingStoreFailed> {
    let held = 0
    for (const folder of unmapped) {
      const ranked = [...folder.candidates].sort((a, b) => b.score - a.score)
      const best = ranked.at(0)
      const rest = ranked.slice(1)
      if (best === undefined) continue
      const leaf = folder.folderPath.split(' / ').at(-1) ?? folder.folderPath
      const rationale =
        `The source folder “${leaf}” is close to ${best.name}, not an exact match` +
        (rest.length > 0
          ? `; also close: ${rest.map((c) => c.name).join(', ')}`
          : '')
      const to: ItemTarget = {
        entityKind: 'company',
        entityId: best.entityId,
        documentKind: null,
      }
      for (const documentId of folder.documentIds) {
        const proposed = yield* query(() =>
          proposeRefileWith(db, {
            documentId,
            from: folder.from,
            to,
            sourcePath: folder.folderPath,
            rationale,
            integrationId,
          }),
        )
        if (proposed) held += 1
      }
    }
    return held
  },
)
