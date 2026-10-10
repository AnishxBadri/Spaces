import type { ReactNode } from 'react'
import { Tabs } from '#/components/ui/tabs'
import type { TabItem } from '#/components/ui/tabs'
import { rememberRecordTab, useLastRecordTab } from '#/lib/record-tab-pref'
import { RECORD_TABS, openRecordTab } from '#/lib/records/record-tabs'
import type { RecordTab } from '#/lib/records/record-tabs'

/**
 * A record's view (D74): the 44px bone tab head — Notes · Interactions ·
 * Files · History, each with its mono count, empty ones grey at 0 — pinned
 * under the folded bar, over the open tab's view. The space page's head,
 * with a record's four tabs.
 */

const LABELS: Record<RecordTab, string> = {
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
  counts: Record<RecordTab, number>
  onTabChange: (tab: RecordTab) => void
  /** Each tab's view; only the open one mounts. */
  panels: Record<RecordTab, ReactNode>
}) {
  const items: Array<TabItem<RecordTab>> = RECORD_TABS.map((id) => ({
    id,
    label: LABELS[id],
    count: counts[id],
  }))
  return (
    <Tabs
      label={label}
      size="head"
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
 * on the tab last used on this kind of record in this browser, else Notes.
 * - `kind` keys the memory: `company`, `person`, `deal`, `o:<object slug>`.
 * - `go` writes the tab into the link, replacing the entry.
 */
export function useRecordTab(
  kind: string,
  linked: RecordTab | undefined,
  go: (tab: RecordTab) => void,
): [RecordTab, (tab: RecordTab) => void] {
  const tab = openRecordTab(linked, useLastRecordTab(kind))
  return [
    tab,
    (next) => {
      rememberRecordTab(kind, next)
      go(next)
    },
  ]
}
