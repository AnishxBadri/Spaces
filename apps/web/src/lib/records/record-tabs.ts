import { z } from 'zod'
import { modalSearchShape } from '#/lib/modal-search'
import { inInteractionFilter } from '#/lib/timeline/interaction-filter'
import type { InteractionFilter } from '#/lib/timeline/interaction-filter'
import { notesCounts } from '#/lib/notes/notes-filter'
import type { NoteLanes, NotesFilter } from '#/lib/notes/notes-filter'

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
  | { type: 'interaction'; kind: string; hasAttachments: boolean }
  | { type: 'macro' | 'attrs' | 'ledger' }

/**
 * Each tab's count: what the tab lists, so an empty one reads 0. The Notes
 * and Interactions counts follow their tab's filter.
 */
export function recordTabCounts({
  notes,
  timeline,
  documents,
  notesFilter = 'all',
  interactionFilter = 'all',
}: {
  notes: NoteLanes<{ id: string }>
  timeline: ReadonlyArray<TimelineRow>
  documents: ReadonlyArray<unknown>
  notesFilter?: NotesFilter
  interactionFilter?: InteractionFilter
}): Record<CountedRecordTab, number> {
  const interactions = timeline.filter((i) => i.type === 'interaction')
  return {
    notes: notesCounts(notes)[notesFilter],
    interactions: interactions.filter((i) =>
      inInteractionFilter(i, interactionFilter),
    ).length,
    files: documents.length,
    history: timeline.length - interactions.length,
  }
}
