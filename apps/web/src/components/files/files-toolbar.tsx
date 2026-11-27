import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FolderGround } from '../page-header'
import { SearchField } from '../ui/search-field'
import { Tabs } from '../ui/tabs'
import { FILES_TABS, filesTabLabel } from '#/lib/documents/files-ledger-view'
import type { FilesTab } from '#/lib/documents/files-ledger-view'

/**
 * The Files page's folder bar: the kind tabs with their counts, then at the
 * right the `Filter` and arrange controls and the search, which ends on the
 * folder's right edge. Holds no state of its own beyond the search's typing:
 * the tab and the search are the page's.
 * - Below `md` the seven tabs scroll in their own bar and the search sits
 *   over them, so nothing pushes the page sideways.
 */
export function FilesToolbar({
  tab,
  counts,
  onTabChange,
  q,
  onSearch,
  filter,
  arrange,
  labelId,
}: {
  tab: FilesTab
  /** Each tab's count. */
  counts: Readonly<Record<FilesTab, number>>
  onTabChange: (tab: FilesTab) => void
  /** The search the list was read with. */
  q: string
  /** Once typing pauses, with the trimmed text. */
  onSearch: (q: string) => void
  /** The `Filter` control's place, before the arrange menu. */
  filter?: ReactNode
  /** The arrange menu's place (`By date`), before the search. */
  arrange?: ReactNode
  /** The open tab's label carries this id: the list is named by it. */
  labelId?: string | undefined
}) {
  const items = FILES_TABS.map((t) => ({
    id: t,
    label: filesTabLabel(t),
    count: counts[t],
  }))
  return (
    <FolderGround>
      <div className="flex pb-2 md:hidden">
        <FilesSearch q={q} onSearch={onSearch} className="w-full" />
      </div>
      <Tabs
        label="Files by kind"
        items={items}
        value={tab}
        onValueChange={onTabChange}
        className="md:hidden"
      />
      <Tabs
        label="Files by kind"
        items={items}
        value={tab}
        onValueChange={onTabChange}
        labelId={labelId}
        flush
        className="hidden md:flex"
        trail={
          <>
            <span className="flex-1" />
            {filter}
            {arrange}
            <FilesSearch q={q} onSearch={onSearch} slash className="w-65" />
          </>
        }
      />
    </FolderGround>
  )
}

/** How long the search waits after the last key before it reads again. */
const SEARCH_QUIET_MS = 250

function FilesSearch({
  q,
  onSearch,
  slash = false,
  className,
}: {
  q: string
  onSearch: (q: string) => void
  slash?: boolean
  className: string
}) {
  const [text, setText] = useState(q)
  const latest = useRef(onSearch)
  latest.current = onSearch

  useEffect(() => {
    if (text.trim() === q) return
    const timer = setTimeout(() => latest.current(text.trim()), SEARCH_QUIET_MS)
    return () => clearTimeout(timer)
  }, [text, q])

  return (
    <SearchField
      value={text}
      onValueChange={setText}
      label="Search names and text"
      placeholder="Search names and text"
      slash={slash}
      className={className}
    />
  )
}
