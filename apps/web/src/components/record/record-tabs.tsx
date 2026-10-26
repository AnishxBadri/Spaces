import type { ReactNode } from 'react'
import { Tabs } from '#/components/ui/tabs'
import type { TabItem } from '#/components/ui/tabs'
import { RECORD_TABS, openRecordTab } from '#/lib/records/record-tabs'
import type { CountedRecordTab, RecordTab } from '#/lib/records/record-tabs'

/**
 * A record's view: the 44px bone tab head — Overview · Notes · Interactions
 * · Files · History, each but Overview with its mono count, empty ones
 * graphite with none — pinned under the folded bar, over the open tab's view.
 */

const LABELS: Record<RecordTab, string> = {
  overview: 'Overview',
  notes: 'Notes',
  interactions: 'Interactions',
  files: 'Files',
  history: 'History',
}

export function RecordTabs({
  label,
  tab,
  counts,
  onTabChange,
  panels,
}: {
  /** Names the tablist: the record's name. */
  label: string
  tab: RecordTab
  counts: Record<CountedRecordTab, number>
  onTabChange: (tab: RecordTab) => void
  /** Each tab's view; only the open one mounts. */
  panels: Record<RecordTab, ReactNode>
}) {
  const items: Array<TabItem<RecordTab>> = RECORD_TABS.map((id) =>
    id === 'overview'
      ? { id, label: LABELS[id], uncounted: true }
      : { id, label: LABELS[id], count: counts[id] },
  )
  return (
    <Tabs
      label={label}
      pinned
      items={items}
      value={tab}
      onValueChange={onTabChange}
    >
      {panels[tab]}
    </Tabs>
  )
}

/**
 * The open tab and its setter. `?tab=` wins; without one the record opens
 * on Overview. `go` writes the tab into the link, replacing the entry.
 */
export function useRecordTab(
  linked: RecordTab | undefined,
  go: (tab: RecordTab) => void,
): [RecordTab, (tab: RecordTab) => void] {
  return [openRecordTab(linked), go]
}
