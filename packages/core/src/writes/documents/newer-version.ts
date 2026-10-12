import { Effect } from 'effect'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, link } from '@spaces/db/schema'
import { ref } from '../../context/ref'
import { DOCUMENT_KIND_LABELS, guessDocumentKind } from '../../documents'
import type { DocumentKind } from '../../documents'
import { formatDate } from '../../format'
import { proposeProgram } from '../suggestions/propose'
import type { Suggestion } from '../suggestions/propose'
import type { SupersedesPayload } from '../../ai/supersedes'

/**
 * The supersedes suggestion: a document filed on a record that already holds
 * one of the same kind proposes "newer version of" the latest. (D59)
 * - Only proposes; the link is written by a person accepting it.
 * - Only kinds that come in versions: a deck and a cap table are revised; two
 *   articles, two legal papers or two diligence files are different facts.
 * - The older is the record's most recent same-kind document filed before
 *   this one that nothing supersedes yet — the head of its chain, so a third
 *   version proposes one row against the second, never two.
 * - A kind of `other` is read from the filename (`guessDocumentKind`): a
 *   forwarded attachment arrives as `other` until classified.
 * - A pair proposed on a record before, open or dismissed, is never proposed
 *   there again (`proposeWith`). Run at intake and on a later filing.
 */

const effectiveKind = (kind: DocumentKind, filename: string | null) =>
  kind !== 'other' || filename === null ? kind : guessDocumentKind(filename)

/** The kinds a newer file replaces rather than adds to. */
const LINEAGE_KINDS: ReadonlySet<DocumentKind> = new Set(['deck', 'cap_table'])

type DocRow = {
  id: string
  name: string
  kind: DocumentKind
  filename: string | null
  createdAt: Date
}

const docColumns = {
  id: document.entityId,
  name: entity.canonicalName,
  kind: document.kind,
  filename: document.filename,
  createdAt: document.createdAt,
}

/** Whether a `supersedes` link already points at `id`. */
const supersededSql = (id: typeof document.entityId) =>
  sql<boolean>`exists (select 1 from ${link} s where s.to_entity_id = ${id} and s.relation = 'supersedes')`

/** The proposals one filing makes: one per record it is filed on, at most. */
async function proposalsFor(documentId: string): Promise<
  Array<{
    recordId: string
    payload: SupersedesPayload
    createdAt: Date
  }>
> {
  const newer = (
    await db
      .select({ ...docColumns, superseded: supersededSql(document.entityId) })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(eq(document.entityId, documentId), isNull(entity.mergedIntoId)),
      )
  ).at(0)
  if (!newer || newer.superseded) return []
  const kind = effectiveKind(newer.kind, newer.filename)
  if (!LINEAGE_KINDS.has(kind)) return []

  const records = await db
    .select({ id: link.toEntityId })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(
      and(
        eq(link.fromEntityId, documentId),
        eq(link.relation, 'tagged_in'),
        isNull(entity.mergedIntoId),
      ),
    )
  if (records.length === 0) return []

  const out: Array<{
    recordId: string
    payload: SupersedesPayload
    createdAt: Date
  }> = []
  for (const record of records) {
    const filed: Array<DocRow & { recordId: string }> = await db
      .select({ ...docColumns, recordId: link.toEntityId })
      .from(link)
      .innerJoin(document, eq(document.entityId, link.fromEntityId))
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(
          eq(link.toEntityId, record.id),
          eq(link.relation, 'tagged_in'),
          isNull(entity.mergedIntoId),
          sql`${document.entityId} <> ${documentId}`,
          // Filed before this one, read in the database: a JS Date drops
          // the microseconds `created_at` holds.
          sql`(${document.createdAt}, ${document.entityId}) < (select n.created_at, n.entity_id from ${document} n where n.entity_id = ${documentId})`,
          sql`not ${supersededSql(document.entityId)}`,
        ),
      )
      .orderBy(desc(document.createdAt), desc(document.entityId))
    const older = filed.find((d) => effectiveKind(d.kind, d.filename) === kind)
    if (!older) continue
    out.push({
      recordId: record.id,
      createdAt: newer.createdAt,
      payload: {
        newerId: newer.id,
        olderId: older.id,
        newerName: newer.name,
        olderName: older.name,
        documentKind: kind,
      },
    })
  }

  // A linked pair needs no check: its older side is superseded, or its
  // newer side is and nothing was proposed.
  return out
}

const proposeAll = Effect.fn('proposeNewerVersion.proposeAll')(function* (
  documentId: string,
) {
  const proposals = yield* Effect.tryPromise(() => proposalsFor(documentId))
  const proposed: Array<Suggestion> = []
  for (const p of proposals) {
    const row = yield* proposeProgram({
      entityId: p.recordId,
      kind: 'supersedes',
      payload: p.payload,
      rationale: `${DOCUMENT_KIND_LABELS[p.payload.documentKind]} filed ${formatDate(p.createdAt)}, after the one this record already holds.`,
      refs: [ref.doc(p.payload.newerId, 0), ref.doc(p.payload.olderId, 0)],
      proposedBy: { type: 'system' },
    })
    proposed.push(row)
  }
  return proposed
})

/**
 * Propose the newer-version link for a document just filed; answers the rows
 * held for its pairs, new or not. Never fails the filing: a refusal or a
 * broken read is logged and nothing is proposed.
 */
export const proposeNewerVersionProgram = (
  documentId: string,
): Effect.Effect<Array<Suggestion>> =>
  proposeAll(documentId).pipe(
    Effect.catch((cause) =>
      Effect.logWarning('newer-version proposal skipped', cause).pipe(
        Effect.as([]),
      ),
    ),
  )
