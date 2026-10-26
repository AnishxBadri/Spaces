import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { duplicateCandidate } from '@spaces/db/schema'
import { mergeEntities } from '@spaces/core/writes/entities/merge'
import { requireUser } from './shared'

/**
 * The review inbox: one queue over typed rows (`duplicate_candidate` pairs
 * and `suggestion` cards). `/dedupe` is a permanent redirect to `/inbox`.
 * A new lane joins by adding a member to `InboxRow` and a renderer to the
 * page's `RENDERERS` map — never a second page.
 *
 * Reads are Effect programs through `effectFn()`; nothing Effect-shaped
 * escapes this file. The programs are imported inside the handlers so their
 * database code never reaches the client bundle.
 */

export type {
  AskCardsRow,
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
export type { SuggestionKind } from '@spaces/core/writes/suggestions/propose'
export type { RecordDuplicate } from '../records/notices'

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
    const user = await requireUser()
    const {
      listInboxProgram,
      inboxScopeRecordProgram,
      inboxFilterLabelsProgram,
    } = await import('../inbox/queue')
    const { effectFn } = await import('./effect')
    const source = data.source ?? null
    const space = data.space ?? null
    const [rows, scope, filter] = await Promise.all([
      effectFn(listInboxProgram)({
        record: data.record,
        source,
        space,
        viewer: user.id,
      }),
      data.record === null
        ? Promise.resolve(null)
        : effectFn(inboxScopeRecordProgram)(data.record),
      source === null && space === null
        ? Promise.resolve(null)
        : effectFn(inboxFilterLabelsProgram)(source, space),
    ])
    return { rows, scope, filter }
  })

/** The open duplicate pairs a record is in, for its notices band. */
export const listRecordDuplicates = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { recordDuplicatesProgram } = await import('../inbox/queue')
    const { effectFn } = await import('./effect')
    return effectFn(recordDuplicatesProgram)(data.entityId)
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
