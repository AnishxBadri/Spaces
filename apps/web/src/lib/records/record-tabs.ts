import { z } from 'zod'
import { modalSearchShape } from '#/lib/modal-search'
import { recordNotesCount } from '#/lib/notes/record-groups'
import type { NoteLanes } from '#/lib/notes/record-groups'
import { threadCount } from '#/lib/timeline/threads'

/**
 * A record body's tabs: Overview · Notes · Interactions · Files · History.
 * There is no Context tab — Ask's answer card carries the sources.
 */
export const RECORD_TABS = [
  'overview',
  'notes',
  'interactions',
  'files',
  'history',
] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** The tabs that carry a count: every one but Overview. */
export type CountedRecordTab = Exclude<RecordTab, 'overview'>

/** A record opens on Overview, every time: no tab is remembered per kind. */
export const DEFAULT_RECORD_TAB: RecordTab = 'overview'

/**
 * `?tab=` deep-links a tab; anything else reads as no tab. `?modal=` opens a
 * window over the Interactions tab.
 */
export const recordSearch = z.object({
  tab: z.enum(RECORD_TABS).optional().catch(undefined),
  ...modalSearchShape,
})

/** The tab a link asks for: its own, else Interactions under a window. */
export function linkedRecordTab(search: {
  tab?: RecordTab | undefined
  modal?: string | undefined
}): RecordTab | undefined {
  if (search.tab !== undefined) return search.tab
  return search.modal === undefined ? undefined : 'interactions'
}

/** The tab to show: the link's, else Overview. */
export function openRecordTab(linked: RecordTab | undefined): RecordTab {
  return linked ?? DEFAULT_RECORD_TAB
}

type TimelineRow =
  | { type: 'interaction'; id: string; threadId: string | null }
  | { type: 'macro' | 'attrs' | 'ledger' }

/**
 * Each tab's count: what the tab lists, so an empty one reads 0. Notes
 * counts each note once, Interactions each thread once.
 */
export function recordTabCounts({
  notes,
  timeline,
  documents,
}: {
  notes: NoteLanes<{ id: string }>
  timeline: ReadonlyArray<TimelineRow>
  documents: ReadonlyArray<unknown>
}): Record<CountedRecordTab, number> {
  const interactions = timeline.filter(
    (i): i is Extract<TimelineRow, { type: 'interaction' }> =>
      i.type === 'interaction',
  )
  return {
    notes: recordNotesCount(notes),
    interactions: threadCount(interactions),
    files: documents.length,
    history: timeline.length - interactions.length,
  }
}
