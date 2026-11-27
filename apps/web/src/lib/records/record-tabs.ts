import { Schema } from 'effect'
import { modalSearchShape } from '#/lib/modal-search'
import { caught, searchValidator } from '#/lib/search-validator'
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
 * window over the record (`linkedRecordTab` picks the tab behind it).
 */
export const recordSearch = searchValidator(
  Schema.Struct({
    tab: caught(Schema.Literals(RECORD_TABS)),
    ...modalSearchShape,
  }),
)

/**
 * The tab a link asks for: its own, else Notes under a note's window, Files
 * under a file's and Interactions under any other.
 */
export function linkedRecordTab(search: {
  tab?: RecordTab | undefined
  modal?: string | undefined
}): RecordTab | undefined {
  if (search.tab !== undefined) return search.tab
  if (search.modal === undefined) return undefined
  if (search.modal === 'note') return 'notes'
  return search.modal === 'file' ? 'files' : 'interactions'
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
 * counts each note once, Interactions each thread once. Files leaves out
 * the folded `From email` band, which carries its own count.
 */
export function recordTabCounts({
  notes,
  timeline,
  documents,
}: {
  notes: NoteLanes<{ id: string }>
  timeline: ReadonlyArray<TimelineRow>
  documents: ReadonlyArray<{ readonly fromEmail: boolean }>
}): Record<CountedRecordTab, number> {
  const interactions = timeline.filter(
    (i): i is Extract<TimelineRow, { type: 'interaction' }> =>
      i.type === 'interaction',
  )
  return {
    notes: recordNotesCount(notes),
    interactions: threadCount(interactions),
    files: documents.filter((d) => !d.fromEmail).length,
    history: timeline.length - interactions.length,
  }
}
