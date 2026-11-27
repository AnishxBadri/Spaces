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
  found,
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
  /** What the search found, in the field: `3 files · 9 places`. */
  found?: string | undefined
  /** The open tab's label carries this id: the list is named by it. */
  labelId?: string | undefined
}) {
  const items = FILES_TABS.map((t) => ({
    id: t,
    label: filesTabLabel(t),
    count: counts[t],
  }))
  // One typed text for both fields, the phone's and the desktop's: with one
  // each, the hidden field answered the other's search with its own empty one.
  const [text, setText] = useState(q)
  const latest = useRef(onSearch)
  latest.current = onSearch
  // A search from outside (Back, a link) replaces the text only while the
  // text still holds the search it replaces; typing ahead of a read wins.
  const before = useRef(q)
  useEffect(() => {
    const was = before.current
    before.current = q
    setText((typed) => (typed.trim() === was ? q : typed))
  }, [q])
  useEffect(() => {
    if (text.trim() === q) return
    const timer = setTimeout(() => latest.current(text.trim()), SEARCH_QUIET_MS)
    return () => clearTimeout(timer)
  }, [text, q])
  // Only while the field holds what the list was read with.
  const shown = text.trim() === q ? found : undefined

  return (
    <FolderGround>
      <div className="flex pb-2 md:hidden">
        <FilesSearch
          text={text}
          onText={setText}
          found={shown}
          className="w-full"
        />
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
            <FilesSearch
              text={text}
              onText={setText}
              found={shown}
              slash
              className="w-65"
            />
          </>
        }
      />
    </FolderGround>
  )
}

/** How long the search waits after the last key before it reads again. */
const SEARCH_QUIET_MS = 250

function FilesSearch({
  text,
  onText,
  slash = false,
  found,
  className,
}: {
  text: string
  onText: (text: string) => void
  found: string | undefined
  slash?: boolean
  className: string
}) {
  return (
    <SearchField
      value={text}
      onValueChange={onText}
      label="Search names and text"
      placeholder="Search names and text"
      slash={slash}
      count={found}
      className={className}
    />
  )
}
