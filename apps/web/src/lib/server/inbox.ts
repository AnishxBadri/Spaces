import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { duplicateCandidate } from '@spaces/db/schema'
import { mergeEntities } from '../entities/merge'
import { requireUser } from './shared'

/**
 * The review inbox (SPA-76, SPA-98) — one queue over typed rows:
 * `duplicate_candidate` pairs and `suggestion` cards. `/inbox` is the
 * surface; `/dedupe` is a permanent redirect to it. Later lanes join by
 * adding a member to `InboxRow` (`lib/inbox/queue.ts`) and a renderer to the
 * page's `RENDERERS` map — never a second page.
 *
 * Reads are Effect programs through the `effectFn()` seam (CONTEXT.md
 * "Backend paradigm"): the handler checks the session, the program does the
 * work, nothing Effect-shaped escapes this file. The programs are imported
 * inside the handlers so their database code never reaches the client
 * bundle this barrel is part of (SPA-155).
 */

export type {
  DuplicateCandidateRow,
  InboxCounts,
  InboxKind,
  InboxRow,
  InboxScopeRecord,
  SuggestionCitation,
  SuggestionField,
  SuggestionItem,
  SuggestionRecord,
  SuggestionRow,
} from '../inbox/queue'
/** One side of a pair: the record plus everything the card compares. */
export type { InboxSide } from '../inbox/context'
export type { SuggestionKind } from '../ai/propose'

/**
 * The queue, optionally scoped to one record (SPA-114: the record rail's
 * "Waiting" chips land here with `?record=`). `scope` is the record's name
 * for the header's dismissible chip, read beside the rows rather than from
 * them — an emptied queue still names what it is scoped to.
 */
export const listInbox = createServerFn()
  .validator(z.object({ record: z.string().uuid().nullable() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { listInboxProgram, inboxScopeRecordProgram } =
      await import('../inbox/queue')
    const { effectFn } = await import('./effect')
    const [rows, scope] = await Promise.all([
      effectFn(listInboxProgram)({ record: data.record }),
      data.record === null
        ? Promise.resolve(null)
        : effectFn(inboxScopeRecordProgram)(data.record),
    ])
    return { rows, scope }
  })

export const countOpenInbox = createServerFn().handler(async () => {
  await requireUser()
  const { countOpenInboxProgram } = await import('../inbox/queue')
  const { effectFn } = await import('./effect')
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
