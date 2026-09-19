import { Effect, Schema } from 'effect'
import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { duplicateCandidate, entity, entityAlias } from '@spaces/db/schema'
import type { DuplicateReason } from '@spaces/db/schema/entities'
import { MERGEABLE } from './merge'

/**
 * The fuzzy-name lane of dedupe, in one module: who is a duplicate of whom,
 * and the pg_trgm sweep that proposes it. Effect-first per the backend
 * paradigm; `sweepNameSimilarity` is the Promise seam, in the same shape as
 * `setValues`/`setValuesEffect`, for `resolveEntity`, which is still
 * Promise-shaped. New Effect code — `createRecordProgram` — composes
 * `sweepNameSimilarityEffect` directly. There is one copy of the similarity
 * SQL and it lives here.
 *
 * Two rules the sweep did not have when it was a private function inside
 * `resolve.ts` (spec-attribute-engine.md §9, "Fuzzy-name dedupe: every
 * object"):
 *
 * 1. **Scope is the object, not the kind.** Every custom record shares the
 *    kind `custom`, so scoping by kind put every custom object's records in
 *    one bucket and a Fund would be offered as a duplicate of a Vendor.
 * 2. **Only pairs the merge executor will actually take.** The sweep reads
 *    `MERGEABLE` rather than relying on which kinds happen to hold name
 *    aliases, so the inbox can never show a pair whose Merge button throws.
 *    Deals hold aliases the moment they are renamed (SPA-63) — the accident
 *    that used to keep them out of the inbox is gone, and this is the
 *    invariant that replaces it.
 */

/**
 * Pinned, and pinned by measurement: `sweep.test.ts` asserts the pg_trgm
 * score of both fixture pairs with `select similarity(...)`, so the two
 * sides of this number — 0.71 suggests, 0.40 does not — are proven rather
 * than asserted in a comment.
 */
export const SIMILARITY_THRESHOLD = 0.5

/** One sweep proposes at most this many pairs; the rest is the nightly job. */
const MAX_SUGGESTIONS = 10

export class SweepFailed extends Schema.TaggedError<SweepFailed>()(
  'SweepFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SweepFailed({ cause }),
  })

/** Follow a merge redirect. Chains are flattened at merge time → one hop. */
export async function canonicalId(id: string): Promise<string> {
  const row = (
    await db
      .select({ mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)
  return row?.mergedIntoId ?? id
}

/** Ordered pair + upsert-ignore: dismissed stays dismissed forever. */
export async function suggestDuplicate(
  a: string,
  b: string,
  score: number,
  reason: DuplicateReason,
) {
  const [entityA, entityB] = a < b ? [a, b] : [b, a]
  await db
    .insert(duplicateCandidate)
    .values({ entityA, entityB, score, reason })
    .onConflictDoNothing()
}

export const sweepNameSimilarityEffect = Effect.fn('sweepNameSimilarity')(
  function* (
    entityId: string,
    nameNorm: string,
  ): Effect.fn.Return<{ suggested: number }, SweepFailed> {
    if (!nameNorm) return { suggested: 0 }

    const self = yield* query(() =>
      db
        .select({ kind: entity.kind, objectId: entity.objectId })
        .from(entity)
        .where(eq(entity.id, entityId))
        .then((rows) => rows.at(0)),
    )
    if (!self) return { suggested: 0 }
    // Rule 2. A `deal`, `space`, `note`, `document` or `term` gets no
    // suggestion because the merge executor refuses it, and a suggestion the
    // user cannot act on is worse than none.
    if (!MERGEABLE.has(self.kind)) return { suggested: 0 }

    // Rule 1, and the fallback the issue spells out: `object_id` is set for
    // every record-of-an-object (the three core kinds and every custom), and
    // null only for the research kinds — `space`, `note`, `document`, `term`
    // — which the MERGEABLE gate above has already sent home. The kind
    // branch is therefore reachable only for a row written straight through
    // drizzle without its object; it is kept so the scope is total rather
    // than relying on that never happening.
    //
    // Scoping by the object is also what makes the pair mergeable on the
    // other side: two rows of one object share a kind, so checking the
    // sweeping row's kind above settles both ends of the pair.
    const scope =
      self.objectId === null
        ? eq(entity.kind, self.kind)
        : eq(entity.objectId, self.objectId)

    const matches = yield* query(() =>
      db
        .selectDistinct({
          otherId: entityAlias.entityId,
          score: sql<number>`similarity(${entityAlias.valueNorm}, ${nameNorm})`,
        })
        .from(entityAlias)
        .innerJoin(entity, eq(entity.id, entityAlias.entityId))
        .where(
          and(
            eq(entityAlias.kind, 'name'),
            ne(entityAlias.entityId, entityId),
            sql`${entityAlias.valueNorm} % ${nameNorm}`,
            sql`similarity(${entityAlias.valueNorm}, ${nameNorm}) >= ${SIMILARITY_THRESHOLD}`,
            scope,
          ),
        )
        .limit(MAX_SUGGESTIONS),
    )

    let suggested = 0
    for (const m of matches) {
      const other = yield* query(() => canonicalId(m.otherId))
      if (other === entityId) continue
      yield* query(() =>
        suggestDuplicate(entityId, other, m.score, {
          name_similarity: nameNorm,
        }),
      )
      suggested++
    }
    return { suggested }
  },
)

/**
 * Promise seam for `resolveEntity`, which the ratchet has not converted yet.
 * New Effect code composes `sweepNameSimilarityEffect` instead.
 */
export const sweepNameSimilarity = (
  entityId: string,
  nameNorm: string,
): Promise<{ suggested: number }> =>
  Effect.runPromise(sweepNameSimilarityEffect(entityId, nameNorm))
