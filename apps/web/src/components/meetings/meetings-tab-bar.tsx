import type { ReactNode } from 'react'
import { FolderGround } from '#/components/page-header'
import { Segmented } from '#/components/ui/segmented'
import { TabDivider, Tabs } from '#/components/ui/tabs'
import { WHOSE, WHOSE_LABEL } from '#/lib/meetings/list'
import type { MeetingCounts, MeetingsTab, Whose } from '#/lib/meetings/list'

/**
 * The Meetings page's folder bar: `Upcoming` and `Past` with their counts,
 * then after a divider the `Mine · Everyone` control, then the bar's end,
 * which holds whatever `trail` is handed (Filter, `Jump to`, the search).
 * Holds no state: the tab and the choice are the page's.
 * - With `whose` null the workspace has one member and there is no control.
 */
export function MeetingsTabBar({
  tab,
  counts,
  onTabChange,
  whose,
  onWhoseChange,
  trail,
}: {
  tab: MeetingsTab
  /** Each tab's count; absent until the first read lands. */
  counts: MeetingCounts | null
  onTabChange: (tab: MeetingsTab) => void
  whose: Whose | null
  onWhoseChange: (whose: Whose) => void
  /** The bar's end, flush with the folder's right edge. */
  trail?: ReactNode
}) {
  return (
    <FolderGround>
      <Tabs
        label="Meetings"
        value={tab}
        onValueChange={onTabChange}
        flush
        items={[
          {
            id: 'upcoming',
            label: 'Upcoming',
            ...(counts === null ? {} : { count: counts.upcoming }),
          },
          {
            id: 'past',
            label: 'Past',
            ...(counts === null ? {} : { count: counts.past }),
          },
        ]}
        trail={
          <>
            {whose === null ? null : (
              <>
                <TabDivider />
                <Segmented
                  label="Whose meetings"
                  value={whose}
                  options={WHOSE.map((w) => ({ id: w, label: WHOSE_LABEL[w] }))}
                  onChange={onWhoseChange}
                  className="shrink-0"
                />
              </>
            )}
            <span className="flex-1" />
            {trail}
          </>
        }
      />
    </FolderGround>
  )
}
