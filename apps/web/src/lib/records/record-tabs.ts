import { z } from 'zod'

/**
 * A record body's tabs (D74): Notes · Interactions · Files · History. There
 * is no Context tab — Ask's answer card carries the sources.
 */
export const RECORD_TABS = [
  'notes',
  'interactions',
  'files',
  'history',
] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** A record opens on Notes. (D74) */
export const DEFAULT_RECORD_TAB: RecordTab = 'notes'

/** `?tab=` deep-links a tab; anything else reads as no tab. */
export const recordSearch = z.object({
  tab: z.enum(RECORD_TABS).optional().catch(undefined),
})

export function isRecordTab(value: string | null): value is RecordTab {
  return value !== null && RECORD_TABS.some((t) => t === value)
}

/** The tab to show: the link's, else the one last used here, else Notes. */
export function openRecordTab(
  linked: RecordTab | undefined,
  remembered: string | null,
): RecordTab {
  if (linked !== undefined) return linked
  return isRecordTab(remembered) ? remembered : DEFAULT_RECORD_TAB
}

/** Each tab's count: what the tab lists, so an empty one reads 0. */
export function recordTabCounts({
  notes,
  timeline,
  documents,
}: {
  notes: { filed: ReadonlyArray<unknown>; mentions: ReadonlyArray<unknown> }
  timeline: ReadonlyArray<{ type: string }>
  documents: ReadonlyArray<unknown>
}): Record<RecordTab, number> {
  const interactions = timeline.filter((i) => i.type === 'interaction').length
  return {
    notes: notes.filed.length + notes.mentions.length,
    interactions,
    files: documents.length,
    history: timeline.length - interactions,
  }
}
