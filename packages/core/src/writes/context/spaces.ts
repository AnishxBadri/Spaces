import { Effect } from 'effect'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { chunk, link, mandate, note, space } from '@spaces/db/schema'
import { ContextLeak, ContextQueryFailed } from '../../context/errors'
import { rank } from '../../context/rank'
import type { Candidate, RankResult } from '../../context/rank'
import { parseRef, ref } from '../../context/ref'
import { truncate } from '../../context/render'
import { fmtMoney } from '../../portfolio/format'
import { canRead } from '../../read-policy'

/**
 * The builders the assembler, its space subject and the watch brief share:
 * the live ancestor chain of some spaces, the memos tagged into them, the
 * mandate, and the ranked, `canRead`-checked output.
 * - `canRead` is applied in SQL: a note is readable when shared or the
 *   reader's own. An integration authors no note, so it reads shared only.
 * - Every fetch is ordered, so a caller's first-wins dedupe is stable.
 */

export const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ContextQueryFailed({ cause }),
  })

/** `canRead` as a SQL predicate over `note`, for one reader. */
export const readableNote = (readerId: string) =>
  or(eq(note.visibility, 'shared'), eq(note.authorId, readerId))

/**
 * Every live space at or above any of `paths`, root first. An archived
 * space leaves the chain; the filings that reached it stay.
 */
export const liveChainOf = (paths: ReadonlyArray<string>) =>
  query(() =>
    db
      .select({ id: space.entityId, path: space.path })
      .from(space)
      .where(
        and(
          or(...paths.map((p) => sql`${space.path} @> ${p}`)),
          isNull(space.archivedAt),
        ),
      )
      .orderBy(asc(space.path)),
  )

/** The memos tagged into these spaces that `readerId` may read. */
export const memosTaggedIn = (
  spaceIds: ReadonlyArray<string>,
  readerId: string,
) =>
  query(async () =>
    spaceIds.length === 0
      ? []
      : db
          .select({ spaceId: link.toEntityId, n: note })
          .from(link)
          .innerJoin(note, eq(note.entityId, link.fromEntityId))
          .where(
            and(
              inArray(link.toEntityId, [...spaceIds]),
              eq(link.relation, 'tagged_in'),
              eq(note.kind, 'memo'),
              readableNote(readerId),
            ),
          )
          .orderBy(asc(link.toEntityId), asc(note.entityId)),
  )

/** A note row let through, kept for the output invariant. */
export type NoteGate = { visibility: string; authorId: string }

/**
 * The active mandate as a standing item, when the reader may read its note.
 * Records its note in `noteRows` for the output invariant.
 */
export const mandateCandidate = Effect.fn('mandateCandidate')(function* (
  readerId: string,
  noteRows: Map<string, NoteGate>,
) {
  const m = (yield* query(() =>
    db
      .select({
        id: mandate.id,
        n: note,
        stages: mandate.stages,
        geos: mandate.geos,
        checkMin: mandate.checkMin,
        checkMax: mandate.checkMax,
        currency: mandate.currency,
      })
      .from(mandate)
      .innerJoin(note, eq(note.entityId, mandate.noteEntityId))
      .where(and(eq(mandate.status, 'active'), readableNote(readerId))),
  )).at(0)
  if (!m) return null
  noteRows.set(m.n.entityId, {
    visibility: m.n.visibility,
    authorId: m.n.authorId,
  })
  const cur = m.currency ?? 'USD'
  const check =
    m.checkMin != null || m.checkMax != null
      ? `Check ${m.checkMin != null ? fmtMoney(m.checkMin, cur) : '?'}–${m.checkMax != null ? fmtMoney(m.checkMax, cur) : '?'}.`
      : ''
  const head = [
    m.stages.length ? `Stages: ${m.stages.join(', ')}.` : '',
    m.geos.length ? `Geos: ${m.geos.join(', ')}.` : '',
    check,
  ]
    .filter(Boolean)
    .join(' ')
  const c: Candidate = {
    ref: ref.mandate(m.id),
    kind: 'mandate',
    text: `Mandate: ${head}\n${truncate(m.n.bodyMd, MANDATE_MAX)}`.trim(),
    entityIds: [],
    at: m.n.updatedAt.toISOString(),
    hop: 'standing',
  }
  return c
})

const MANDATE_MAX = 2000

/**
 * Rank, then hold the output to `canRead`: a hit means a fetch lost its
 * filter, a bug rather than a policy decision.
 */
export const rankChecked = Effect.fn('rankChecked')(function* (
  candidates: ReadonlyArray<Candidate>,
  noteRows: ReadonlyMap<string, NoteGate>,
  opts: { user: { id: string }; asOf: string; budgetChars: number },
): Effect.fn.Return<RankResult, ContextLeak> {
  const result = rank(candidates, {
    asOf: opts.asOf,
    budgetChars: opts.budgetChars,
  })
  for (const item of result.items)
    for (const id of item.entityIds) {
      const row = noteRows.get(id)
      if (row && !canRead(opts.user, row))
        return yield* new ContextLeak({
          ref: item.ref,
          message: 'canRead refused an assembled item',
        })
    }
  return result
})

/**
 * The output invariant of `excludeSensitive`: no item cut from a chunk
 * stamped `sensitive` may leave — a document chunk, or a judgment-memory
 * note or close_reason. Re-reads the stamps rather than trusting the
 * fetch; a hit means a fetch lost its filter, a bug like `rankChecked`'s.
 */
export const sensitiveChecked = Effect.fn('sensitiveChecked')(function* (
  items: ReadonlyArray<Pick<Candidate, 'ref' | 'hop'>>,
): Effect.fn.Return<void, ContextQueryFailed | ContextLeak> {
  const cut: Array<SQL> = []
  for (const item of items) {
    const p = parseRef(item.ref)
    if (p?.kind === 'doc')
      cut.push(
        sql`(${chunk.entityId} = ${p.entityId}::uuid and ${chunk.sourceKind} = 'document' and ${chunk.idx} = ${p.idx})`,
      )
    else if (item.hop === 'similar' && p?.kind === 'note')
      cut.push(
        sql`(${chunk.entityId} = ${p.entityId}::uuid and ${chunk.sourceKind} = 'note')`,
      )
    else if (item.hop === 'similar' && p?.kind === 'attr')
      cut.push(
        sql`(${chunk.entityId} = ${p.entityId}::uuid and ${chunk.sourceKind} = 'attribute' and ${chunk.sourceKey} = ${p.slug})`,
      )
  }
  if (cut.length === 0) return
  const hit = (yield* query(() =>
    db
      .select({
        entityId: chunk.entityId,
        sourceKind: chunk.sourceKind,
        sourceKey: chunk.sourceKey,
        idx: chunk.idx,
      })
      .from(chunk)
      .where(and(eq(chunk.sensitive, true), or(...cut)))
      .orderBy(asc(chunk.entityId), asc(chunk.idx))
      .limit(1),
  )).at(0)
  if (hit === undefined) return
  return yield* new ContextLeak({
    ref:
      hit.sourceKind === 'document'
        ? ref.doc(hit.entityId, hit.idx)
        : hit.sourceKind === 'note'
          ? ref.note(hit.entityId)
          : ref.attr(hit.entityId, hit.sourceKey),
    message: 'A chunk stamped sensitive reached an excludeSensitive assembly',
  })
})

/** Every entity id the ranked items are about, the seed's first. */
export const revealed = (
  seedId: string,
  items: ReadonlyArray<{ entityIds: ReadonlyArray<string> }>,
  more: ReadonlyArray<string> = [],
): ReadonlyArray<string> => [
  ...new Set([seedId, ...items.flatMap((i) => i.entityIds), ...more]),
]
