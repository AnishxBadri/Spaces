import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { count, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { duplicateCandidate } from '@spaces/db/schema'
import type { DuplicateReason } from '@spaces/db/schema/entities'
import { mergeEntities } from '../entities/merge'
import { entityContext } from '../inbox/context'
import type { InboxSide } from '../inbox/context'
import { effectFn } from './effect'
import { requireUser } from './shared'

/** One side of a pair: the record plus everything the card compares. */
export type { InboxSide }

/**
 * The review inbox (SPA-76) — one queue over typed rows, of which
 * `duplicate_candidate` is the only member today. `/inbox` is the surface;
 * `/dedupe` is a permanent redirect to it. Later lanes (the suggestion
 * table, spec-ai-substrate.md §10) join by adding a member to `InboxRow`
 * and a renderer to the page's `RENDERERS` map — never a second page.
 *
 * Reads are Effect programs through the `effectFn()` seam (CONTEXT.md
 * "Backend paradigm"): the handler checks the session, the program does the
 * work, nothing Effect-shaped escapes this file.
 */

class InboxQueryFailed extends Schema.TaggedError<InboxQueryFailed>()(
  'InboxQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InboxQueryFailed({ cause }),
  })

/**
 * A pair the sweep proposed, still open. The `kind` is the discriminant the
 * page dispatches on — it is stored nowhere, it is what this lane *is*.
 */
export type DuplicateCandidateRow = {
  kind: 'duplicate_candidate'
  id: string
  score: number
  reason: DuplicateReason
  a: InboxSide
  b: InboxSide
}

/**
 * Every row the inbox can hold. Add a lane by adding a member here and a
 * renderer in `routes/_app/inbox.tsx` — the queue, the count and the page
 * follow. Nothing else in the app switches on this union.
 */
export type InboxRow = DuplicateCandidateRow

export type InboxKind = InboxRow['kind']

/** `open` is the whole queue; `byKind` is what each lane contributes. */
export type InboxCounts = {
  open: number
  byKind: Record<InboxKind, number>
}

const listInboxProgram = Effect.fn('listInboxProgram')(
  function* (): Effect.fn.Return<Array<InboxRow>, InboxQueryFailed> {
    const rows = yield* query(() =>
      db
        .select()
        .from(duplicateCandidate)
        .where(eq(duplicateCandidate.status, 'open'))
        .orderBy(
          desc(duplicateCandidate.score),
          desc(duplicateCandidate.createdAt),
        ),
    )
    return yield* query(() =>
      Promise.all(
        rows.map(async (r): Promise<InboxRow> => ({
          kind: 'duplicate_candidate',
          id: r.id,
          score: r.score,
          reason: r.reason,
          a: await entityContext(r.entityA),
          b: await entityContext(r.entityB),
        })),
      ),
    )
  },
)

/**
 * One grouped query, not one query per lane and never the list itself:
 * Today used to call `listDuplicates()` — four queries per side per pair —
 * to read `.length`. The `kind` column is a literal because there is one
 * lane; the second lane makes this a `union all` of the same two columns,
 * and every caller keeps reading `byKind`.
 */
const countOpenInboxProgram = Effect.fn('countOpenInboxProgram')(
  function* (): Effect.fn.Return<InboxCounts, InboxQueryFailed> {
    const rows = yield* query(() =>
      db
        .select({
          kind: sql<InboxKind>`'duplicate_candidate'`.as('kind'),
          value: count(),
        })
        .from(duplicateCandidate)
        .where(eq(duplicateCandidate.status, 'open'))
        .groupBy(sql`1`),
    )
    const byKind: Record<InboxKind, number> = { duplicate_candidate: 0 }
    let open = 0
    for (const row of rows) {
      byKind[row.kind] = row.value
      open += row.value
    }
    return { open, byKind }
  },
)

export const listInbox = createServerFn().handler(async () => {
  await requireUser()
  return effectFn(listInboxProgram)()
})

export const countOpenInbox = createServerFn().handler(async () => {
  await requireUser()
  return effectFn(countOpenInboxProgram)()
})

export const mergeDuplicate = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      candidateId: z.string().uuid(),
      winnerId: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const cand = (
      await db
        .select()
        .from(duplicateCandidate)
        .where(eq(duplicateCandidate.id, data.candidateId))
    ).at(0)
    if (!cand || cand.status !== 'open') throw new Error('Candidate not open')
    if (data.winnerId !== cand.entityA && data.winnerId !== cand.entityB)
      throw new Error('Winner must be one of the pair')
    const loserId = data.winnerId === cand.entityA ? cand.entityB : cand.entityA
    await mergeEntities({
      winnerId: data.winnerId,
      loserId,
      mergedBy: u.id,
      candidateId: data.candidateId,
    })
    return { ok: true }
  })

export const dismissDuplicate = createServerFn({ method: 'POST' })
  .validator(z.object({ candidateId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    await db
      .update(duplicateCandidate)
      .set({ status: 'dismissed', resolvedBy: u.id, resolvedAt: new Date() })
      .where(eq(duplicateCandidate.id, data.candidateId))
    return { ok: true }
  })
