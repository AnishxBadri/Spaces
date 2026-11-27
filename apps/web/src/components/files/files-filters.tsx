import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, Email, Folder, Link as LinkGlyph, icon } from '../icons'
import type { IconComponent } from '../icons'
import { ArrangeMenu } from '../list/arrange-menu'
import type { AppliedFilter } from '../list/filter-chips'
import { FilterControl } from '../list/filter-panel'
import type { FilterFacetRow } from '../list/filter-panel'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Select } from '../ui/select'
import { FilingKindIcon, FilingName } from './file-under'
import { getFilingTargets, listFilesFacets } from '#/lib/server-fns'
import type { FileUnderOption } from '#/lib/documents/file-under'
import type { FilesFacets } from '#/lib/documents/files-facets'
import {
  FILES_FORMATS,
  FILES_FROM,
  FILES_GROUPS,
  FILES_LOOKS,
  FILES_SORTS,
  FORMAT_LABELS,
  FROM_LABELS,
  GROUP_LABELS,
  LOOK_LABELS,
  NO_FILTERS,
  SORT_LABELS,
  arrangeLabel,
  filtersOn,
  toggled,
} from '#/lib/documents/files-filter'
import type {
  FilesFilters,
  FilesFrom,
  FilesGroup,
  FilesSort,
} from '#/lib/documents/files-filter'
import type { FilesTab } from '#/lib/documents/files-ledger-view'
import { cn } from '#/lib/utils'

/**
 * The Files page's facets, applied filters and arrangements, handed to the
 * shared list parts (`FilterControl`, `FilterChips`, `ArrangeMenu`) as
 * data. The only place that knows what a Files filter is called.
 */

const FROM_ICONS: Readonly<Record<FilesFrom, IconComponent>> = {
  upload: icon.upload,
  email: Email,
  drive: Folder,
  link: LinkGlyph,
}

/** How an applied `From` filter reads in the chips row. */
const FROM_APPLIED: Readonly<Record<FilesFrom, string>> = {
  upload: 'Uploaded',
  email: 'From email',
  drive: 'From Drive',
  link: 'From a link',
}

/** The crimson square `Text not read` wears on a row. */
const UNREAD_MARK = (
  <span aria-hidden className="size-1.5 shrink-0 bg-destructive" />
)

/**
 * `Filter n` and its panel. The chip counts are read when the panel opens,
 * and again while it stays open and the filters, the tab or the search
 * change.
 */
export function FilesFilter({
  tab,
  q,
  filters,
  underName,
  onChange,
}: {
  tab: FilesTab
  q: string
  filters: FilesFilters
  /** The record or space `under` names, for the picker's face. */
  underName: string | null
  onChange: (filters: FilesFilters) => void
}) {
  const [open, setOpen] = useState(false)
  const [facets, setFacets] = useState<FilesFacets | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    listFilesFacets({ data: { tab, q, filters } }).then(
      (next) => {
        if (live) setFacets(next)
      },
      () => {
        if (live) setFacets(null)
      },
    )
    return () => {
      live = false
    }
  }, [open, tab, q, filters])

  const n = (count: number | undefined) =>
    facets === null ? null : (count ?? 0)
  const rows: ReadonlyArray<FilterFacetRow> = [
    {
      id: 'under',
      label: 'Filed under',
      picker: (
        <UnderPicker
          value={filters.under}
          name={underName}
          onChange={(under) => onChange({ ...filters, under })}
        />
      ),
      chips: [{ id: 'unfiled', label: 'Unfiled', count: n(facets?.unfiled) }],
    },
    {
      id: 'from',
      label: 'From',
      chips: FILES_FROM.map((f) => ({
        id: f,
        label: FROM_LABELS[f],
        icon: FROM_ICONS[f],
        count: n(facets?.from[f]),
      })),
    },
    {
      id: 'type',
      label: 'Type',
      chips: FILES_FORMATS.map((f) => ({
        id: f,
        label: FORMAT_LABELS[f],
        count: n(facets?.type[f]),
      })),
    },
    {
      id: 'by',
      label: 'Added by',
      picker: (
        <Select
          aria-label="Added by"
          value={filters.by ?? ''}
          onChange={(by) => onChange({ ...filters, by: by === '' ? null : by })}
          items={[
            { value: '', label: 'Anyone' },
            ...(facets?.by ?? []).map((m) => ({
              value: m.id,
              label: m.name,
              render: (
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{m.name}</span>
                  <span className="tabular shrink-0 mono text-micro text-graphite">
                    {m.count.toLocaleString('en-US')}
                  </span>
                </span>
              ),
            })),
          ]}
          width="content"
          placeholder="Anyone"
          className="h-7 w-42 border-hairline text-label"
        />
      ),
      chips: [],
    },
    {
      id: 'look',
      label: 'Needs a look',
      chips: FILES_LOOKS.map((l) => ({
        id: l,
        label: LOOK_LABELS[l],
        count: n(facets?.look[l]),
        ...(l === 'unread' ? { mark: UNREAD_MARK } : {}),
      })),
    },
  ]

  return (
    <FilterControl
      facets={rows}
      on={{
        under: filters.unfiled ? ['unfiled'] : [],
        from: filters.from,
        type: filters.type,
        look: filters.look,
      }}
      onToggle={(facet, chip) => onChange(toggledFilter(filters, facet, chip))}
      onClear={() => onChange(NO_FILTERS)}
      active={filtersOn(filters)}
      count={
        facets === null ? null : { shown: facets.shown, total: facets.total }
      }
      open={open}
      onOpenChange={setOpen}
    />
  )
}

/** The filters with one chip pressed: on when it was off, off when on. */
function toggledFilter(
  f: FilesFilters,
  facet: string,
  chip: string,
): FilesFilters {
  switch (facet) {
    case 'under':
      return { ...f, unfiled: !f.unfiled }
    case 'from': {
      const value = FILES_FROM.find((v) => v === chip)
      return value === undefined
        ? f
        : { ...f, from: toggled(f.from, value, FILES_FROM) }
    }
    case 'type': {
      const value = FILES_FORMATS.find((v) => v === chip)
      return value === undefined
        ? f
        : { ...f, type: toggled(f.type, value, FILES_FORMATS) }
    }
    case 'look': {
      const value = FILES_LOOKS.find((v) => v === chip)
      return value === undefined
        ? f
        : { ...f, look: toggled(f.look, value, FILES_LOOKS) }
    }
    default:
      return f
  }
}

/** The filters that are on, as the chips row under the tab bar draws them. */
export function filesAppliedFilters(
  f: FilesFilters,
  named: { readonly under: string | null; readonly by: string | null },
  onChange: (filters: FilesFilters) => void,
): Array<AppliedFilter> {
  const out: Array<AppliedFilter> = []
  if (f.under !== null)
    out.push({
      key: `under:${f.under}`,
      label: `Under ${named.under ?? 'a record'}`,
      onRemove: () => onChange({ ...f, under: null }),
    })
  if (f.unfiled)
    out.push({
      key: 'under:unfiled',
      label: 'Unfiled',
      onRemove: () => onChange({ ...f, unfiled: false }),
    })
  for (const v of f.from)
    out.push({
      key: `from:${v}`,
      label: FROM_APPLIED[v],
      icon: FROM_ICONS[v],
      onRemove: () => onChange({ ...f, from: f.from.filter((x) => x !== v) }),
    })
  for (const v of f.type)
    out.push({
      key: `type:${v}`,
      label: FORMAT_LABELS[v],
      onRemove: () => onChange({ ...f, type: f.type.filter((x) => x !== v) }),
    })
  if (f.by !== null)
    out.push({
      key: `by:${f.by}`,
      label: `Added by ${named.by ?? 'a member'}`,
      onRemove: () => onChange({ ...f, by: null }),
    })
  for (const v of f.look)
    out.push({
      key: `look:${v}`,
      label: LOOK_LABELS[v],
      onRemove: () => onChange({ ...f, look: f.look.filter((x) => x !== v) }),
    })
  return out
}

/** The arrange menu with the Files groupings and sorts. */
export function FilesArrange({
  group,
  sort,
  onGroup,
  onSort,
}: {
  group: FilesGroup
  sort: FilesSort
  onGroup: (group: FilesGroup) => void
  onSort: (sort: FilesSort) => void
}) {
  return (
    <ArrangeMenu
      label={arrangeLabel(group)}
      groups={FILES_GROUPS.map((g) => ({ id: g, label: GROUP_LABELS[g] }))}
      group={group}
      onGroup={onGroup}
      sorts={FILES_SORTS.map((s) => ({ id: s, label: SORT_LABELS[s] }))}
      sort={sort}
      onSort={onSort}
    />
  )
}

/**
 * `Any record or space`: a search over records and spaces, as the `File
 * under…` popover searches them, that narrows the list to one.
 */
function UnderPicker({
  value,
  name,
  onChange,
}: {
  value: string | null
  name: string | null
  onChange: (under: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [bands, setBands] = useState<ReadonlyArray<{
    label: string
    options: ReadonlyArray<FileUnderOption>
  }> | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    const read = () =>
      getFilingTargets({ data: { q } }).then(
        (next) => {
          if (live) setBands(next)
        },
        () => {
          if (live) setBands([])
        },
      )
    // The first read is at once; typing waits for a pause.
    if (q.trim() === '') {
      void read()
      return () => {
        live = false
      }
    }
    const t = setTimeout(() => void read(), 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [open, q])

  const choose = (option: FileUnderOption | null) => {
    setPicked(option?.name ?? null)
    onChange(option?.target.entityId ?? null)
    setOpen(false)
    setQ('')
  }

  const face =
    value === null ? 'Any record or space' : (name ?? picked ?? 'A record')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-filter-picker="under"
          className="focus-ring flex h-7 w-42 shrink-0 items-center justify-between gap-1.5 rounded-md border border-hairline bg-paper pr-1.5 pl-2.5 text-left text-label text-foreground transition-colors duration-100 ease-out-quart hover:bg-bone"
        >
          <span className="min-w-0 truncate">{face}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-75 p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          input.current?.focus()
        }}
      >
        <div className="flex h-9 items-center gap-2 border-b border-rule px-2.5">
          <icon.search aria-hidden className="size-4 shrink-0 text-graphite" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search records and spaces"
            aria-label="Search records and spaces"
            className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-graphite"
          />
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          <PickerRow selected={value === null} onPick={() => choose(null)}>
            <span className="min-w-0 flex-1 truncate text-ui">
              Any record or space
            </span>
          </PickerRow>
          {(bands ?? []).map((band) => (
            <div key={band.label} role="group" aria-label={band.label}>
              <div className="flex h-7 items-center px-2.5 label-caps text-graphite">
                {band.label}
              </div>
              {band.options.map((o) => (
                <PickerRow
                  key={o.target.entityId}
                  selected={o.target.entityId === value}
                  onPick={() => choose(o)}
                >
                  <FilingKindIcon option={o} />
                  <FilingName option={o} />
                </PickerRow>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function PickerRow({
  selected,
  onPick,
  children,
}: {
  selected: boolean
  onPick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        'focus-ring-inset flex h-7 w-full items-center gap-2 px-2.5 text-left hover:bg-bone',
        selected && 'font-medium',
      )}
    >
      {children}
    </button>
  )
}
