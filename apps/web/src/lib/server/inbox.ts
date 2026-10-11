import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { duplicateCandidate } from '@spaces/db/schema'
import { mergeEntities } from '@spaces/core/writes/entities/merge'
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
  CapturedPage,
  ColumnRunRow,
  ColumnRunSummary,
  DiscoveryRow,
  DiscoverySpace,
  DuplicateCandidateRow,
  InboxFilterLabels,
  InboxKind,
  InboxLane,
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
 * The queue, optionally scoped to one record (the record rail's "Waiting"
 * chips land here with `?record=`) or to Today's source and space. `scope`
 * and `filter` name them for the header's dismissible chips, read beside the
 * rows rather than from them — an emptied queue still names its scope.
 */
export const listInbox = createServerFn()
  .validator(
    z.object({
      record: z.string().uuid().nullable(),
      source: z.string().min(1).max(100).nullable().optional(),
      space: z.string().uuid().nullable().optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const {
      listInboxProgram,
      inboxScopeRecordProgram,
      inboxFilterLabelsProgram,
    } = await import('../inbox/queue')
    const { effectFn } = await import('./effect')
    const source = data.source ?? null
    const space = data.space ?? null
    const [rows, scope, filter] = await Promise.all([
      effectFn(listInboxProgram)({ record: data.record, source, space }),
      data.record === null
        ? Promise.resolve(null)
        : effectFn(inboxScopeRecordProgram)(data.record),
      source === null && space === null
        ? Promise.resolve(null)
        : effectFn(inboxFilterLabelsProgram)(source, space),
    ])
    return { rows, scope, filter }
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
