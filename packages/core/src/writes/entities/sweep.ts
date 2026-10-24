import { Effect, Schema } from 'effect'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { duplicateCandidate, entity, entityAlias } from '@spaces/db/schema'
import type { DuplicateReason } from '@spaces/db/schema/entities'
import { MERGEABLE } from './merge'
import type { Executor } from './resolve'

/**
 * The fuzzy-name lane of dedupe: who is a duplicate of whom, and the pg_trgm
 * sweep that proposes it. The one copy of the similarity SQL lives here.
 * 1. Scope is the object, not the kind: every custom record is kind
 *    `custom`, so a kind scope would offer a Fund as a duplicate of a Vendor.
 * 2. Only pairs the merge executor takes: the sweep reads `MERGEABLE`, so the
 *    inbox never shows a pair whose Merge button throws (deals hold name
 *    aliases once renamed).
 */

/**
 * Pinned by measurement: the sweep's test asserts the pg_trgm score of both fixture pairs with `select similarity(...)`, so the two
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

/**
 * Follow a merge redirect. Chains are flattened at merge time → one hop.
 *
 * `on` is the executor: `db` by default, a caller's
 * transaction when the redirect has to be read against writes that
 * transaction has not committed yet.
 */
export async function canonicalId(
  id: string,
  on: Executor = db,
): Promise<string> {
  const row = (
    await on
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
  on: Executor = db,
) {
  const [entityA, entityB] = a < b ? [a, b] : [b, a]
  await on
    .insert(duplicateCandidate)
    .values({ entityA, entityB, score, reason })
    .onConflictDoNothing()
}

/**
 * The name aliases in `scope` whose pg_trgm similarity to `nameNorm` is at
 * least `threshold`, one row per (record, score), at most
 * `MAX_SUGGESTIONS`. Reads only; the one copy of the similarity SQL.
 */
export function similarNames(
  nameNorm: string,
  scope: SQL,
  options: { readonly excludeId: string | null; readonly threshold: number },
): Promise<Array<{ otherId: string; score: number }>> {
  return db
    .selectDistinct({
      otherId: entityAlias.entityId,
      score: sql<number>`similarity(${entityAlias.valueNorm}, ${nameNorm})`,
    })
    .from(entityAlias)
    .innerJoin(entity, eq(entity.id, entityAlias.entityId))
    .where(
      and(
        eq(entityAlias.kind, 'name'),
        options.excludeId === null
          ? undefined
          : ne(entityAlias.entityId, options.excludeId),
        sql`${entityAlias.valueNorm} % ${nameNorm}`,
        sql`similarity(${entityAlias.valueNorm}, ${nameNorm}) >= ${options.threshold}`,
        scope,
      ),
    )
    .limit(MAX_SUGGESTIONS)
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

    // Rule 1. `object_id` is null only for the research kinds, which the
    // MERGEABLE gate already sent home; the kind branch covers a row written
    // without its object, so the scope is total. Two rows of one object share
    // a kind, so the gate above settles both ends of the pair.
    const scope =
      self.objectId === null
        ? eq(entity.kind, self.kind)
        : eq(entity.objectId, self.objectId)

    const matches = yield* query(() =>
      similarNames(nameNorm, scope, {
        excludeId: entityId,
        threshold: SIMILARITY_THRESHOLD,
      }),
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
 * Promise seam for `resolveEntity`, which is Promise-shaped. New Effect code composes `sweepNameSimilarityEffect` instead.
 */
export const sweepNameSimilarity = (
  entityId: string,
  nameNorm: string,
): Promise<{ suggested: number }> =>
  Effect.runPromise(sweepNameSimilarityEffect(entityId, nameNorm))
