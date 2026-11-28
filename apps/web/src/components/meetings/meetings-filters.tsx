import { useCallback, useEffect, useRef, useState } from 'react'
import { Calendar, ChevronDown, icon } from '#/components/icons'
import { KindIcon } from '#/components/kind-icon'
import type { AppliedFilter } from '#/components/list/filter-chips'
import { FilterControl } from '#/components/list/filter-panel'
import type { FilterFacetRow } from '#/components/list/filter-panel'
import { PickPopover } from '#/components/record/details-add'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  MenuCheck,
} from '#/components/ui/dropdown-menu'
import { SearchField } from '#/components/ui/search-field'
import { Select } from '#/components/ui/select'
import {
  KIND_LABELS,
  MEETING_KINDS,
  NO_MEETING_FILTERS,
  WRITE_UP_FILTERS,
  WRITE_UP_LABELS,
  meetingFiltersOn,
  toggledValue,
} from '#/lib/meetings/filter'
import type { MeetingsFilters } from '#/lib/meetings/filter'
import { monthName, monthsByYear, upcomingHorizon } from '#/lib/meetings/list'
import type { MeetingsTab, Whose } from '#/lib/meetings/list'
import { listMeetingFacets, searchEntities } from '#/lib/server-fns'
import type { MeetingFacets } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * The Meetings page's `Filter`, `Jump to`, search and applied filters,
 * handed to the shared list parts as data. The only place that knows what a
 * Meetings filter is called.
 */

/** What the panel's counts and the months are read under. */
export type FacetsRead = {
  readonly tab: MeetingsTab
  readonly whose: Whose
  readonly q: string
  readonly filters: MeetingsFilters
  readonly tz: string
}

/** `19 meetings`, grouped and never compact. */
export const meetingsWord = (n: number) =>
  `${n.toLocaleString('en-US')} meeting${n === 1 ? '' : 's'}`

/**
 * The panel's counts and the months, read while `open` and again while it
 * stays open and what they are read under changes; null while read.
 */
function useFacets(open: boolean, read: FacetsRead): MeetingFacets | null {
  const [facets, setFacets] = useState<MeetingFacets | null>(null)
  const { tab, whose, q, filters, tz } = read
  useEffect(() => {
    if (!open) return
    let live = true
    const at = new Date()
    listMeetingFacets({
      data: {
        tab,
        whose,
        q,
        filters,
        tz,
        now: at.toISOString(),
        until: upcomingHorizon(at).toISOString(),
      },
    }).then(
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
  }, [open, tab, whose, q, filters, tz])
  return facets
}

/**
 * `Filter n` and its panel. Past's rows are `With`, `Member`, `Kind`,
 * `Write-up` and `Cancelled` (`Show`); Upcoming's are `With`, `Member` and
 * `Cancelled` (`Hide`).
 */
export function MeetingsFilter({
  read,
  named,
  onChange,
}: {
  read: FacetsRead
  /** The names the address's `with` and `member` stand for, once read. */
  named: { readonly with: string | null; readonly member: string | null }
  onChange: (filters: MeetingsFilters) => void
}) {
  const [open, setOpen] = useState(false)
  const facets = useFacets(open, read)
  const { tab, filters } = read
  const n = (count: number | undefined) =>
    facets === null ? null : (count ?? 0)
  const members = facets?.members ?? []
  const rows: Array<FilterFacetRow> = [
    {
      id: 'with',
      label: 'With',
      picker: (
        <WithPicker
          value={filters.with}
          name={named.with}
          onChange={(w) => onChange({ ...filters, with: w })}
        />
      ),
      chips: [],
    },
    {
      id: 'member',
      label: 'Member',
      picker: (
        <Select
          aria-label="Member"
          value={filters.member ?? ''}
          onChange={(m) =>
            onChange({ ...filters, member: m === '' ? null : m })
          }
          items={[
            { value: '', label: 'Anyone' },
            ...(members.length === 0 &&
            filters.member !== null &&
            named.member !== null
              ? [{ value: filters.member, label: named.member }]
              : members.map((m) => ({ value: m.id, label: m.name }))),
          ]}
          width="content"
          placeholder="Anyone"
          className="h-7 w-50 border-hairline text-label"
        />
      ),
      chips: [],
    },
    ...(tab === 'past'
      ? [
          {
            id: 'kind',
            label: 'Kind',
            chips: MEETING_KINDS.map((k) => ({
              id: k,
              label: KIND_LABELS[k],
              count: n(facets?.kind[k]),
            })),
          },
          {
            id: 'writeUp',
            label: 'Write-up',
            chips: WRITE_UP_FILTERS.map((w) => ({
              id: w,
              label: WRITE_UP_LABELS[w],
              count: n(facets?.writeUp[w]),
            })),
          },
        ]
      : []),
    {
      id: 'cancelled',
      label: 'Cancelled',
      chips: [
        {
          id: 'cancelled',
          label: tab === 'past' ? 'Show' : 'Hide',
          count: n(facets?.cancelled),
        },
      ],
    },
  ]
  const active = meetingFiltersOn(filters, tab)
  return (
    <FilterControl
      facets={rows}
      on={{
        kind: tab === 'past' ? filters.kind : [],
        writeUp: tab === 'past' ? filters.writeUp : [],
        cancelled: filters.cancelled ? ['cancelled'] : [],
      }}
      onToggle={(facet, chip) => onChange(toggledFilter(filters, facet, chip))}
      onClear={() => onChange(NO_MEETING_FILTERS)}
      active={active}
      count={
        facets === null ? null : { shown: facets.shown, total: facets.total }
      }
      {...(facets !== null && active === 0 && read.q === ''
        ? { words: meetingsWord(facets.total) }
        : {})}
      open={open}
      onOpenChange={setOpen}
    />
  )
}

/** The filters with one chip pressed: on when it was off, off when on. */
function toggledFilter(
  f: MeetingsFilters,
  facet: string,
  chip: string,
): MeetingsFilters {
  switch (facet) {
    case 'kind': {
      const value = MEETING_KINDS.find((v) => v === chip)
      return value === undefined
        ? f
        : { ...f, kind: toggledValue(f.kind, value, MEETING_KINDS) }
    }
    case 'writeUp': {
      const value = WRITE_UP_FILTERS.find((v) => v === chip)
      return value === undefined
        ? f
        : { ...f, writeUp: toggledValue(f.writeUp, value, WRITE_UP_FILTERS) }
    }
    case 'cancelled':
      return { ...f, cancelled: !f.cancelled }
    default:
      return f
  }
}

/** How an applied `Write-up` value reads in the chips row. */
const WRITE_UP_APPLIED = {
  written: 'Written up',
  none: 'No write-up',
  recorder: 'By a recorder',
} as const

/** The filters that are on in the open tab, as the chips row draws them. */
export function meetingsAppliedFilters(
  f: MeetingsFilters,
  tab: MeetingsTab,
  named: { readonly with: string | null; readonly member: string | null },
  onChange: (filters: MeetingsFilters) => void,
): Array<AppliedFilter> {
  const out: Array<AppliedFilter> = []
  if (f.with !== null)
    out.push({
      key: `with:${f.with}`,
      label: `With ${named.with ?? 'a record'}`,
      onRemove: () => onChange({ ...f, with: null }),
    })
  if (f.member !== null)
    out.push({
      key: `member:${f.member}`,
      label: `Member ${named.member ?? 'a member'}`,
      onRemove: () => onChange({ ...f, member: null }),
    })
  if (tab === 'past') {
    for (const v of f.kind)
      out.push({
        key: `kind:${v}`,
        label: KIND_LABELS[v],
        onRemove: () => onChange({ ...f, kind: f.kind.filter((x) => x !== v) }),
      })
    for (const v of f.writeUp)
      out.push({
        key: `writeUp:${v}`,
        label: WRITE_UP_APPLIED[v],
        onRemove: () =>
          onChange({ ...f, writeUp: f.writeUp.filter((x) => x !== v) }),
      })
  }
  if (f.cancelled)
    out.push({
      key: 'cancelled',
      label: tab === 'past' ? 'Cancelled shown' : 'Cancelled hidden',
      onRemove: () => onChange({ ...f, cancelled: false }),
    })
  return out
}

/**
 * `Any company or person`: a search over companies and people, as the
 * meeting's `Pin a record…` searches them, that narrows the list to the
 * meetings edged to one.
 */
function WithPicker({
  value,
  name,
  onChange,
}: {
  value: string | null
  name: string | null
  onChange: (record: string | null) => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const search = useCallback(
    (q: string) =>
      searchEntities({ data: { q, kinds: ['company', 'person'] } }),
    [],
  )
  const face =
    value === null ? 'Any company or person' : (name ?? picked ?? 'A record')
  return (
    <PickPopover
      placeholder="Search companies and people…"
      search={search}
      lead={(hit) => <KindIcon of={{ kind: hit.kind }} />}
      onPick={(hit) => {
        setPicked(hit.name)
        onChange(hit.id)
        return Promise.resolve()
      }}
      foot={(close) =>
        value === null ? null : (
          <button
            type="button"
            onClick={() => {
              onChange(null)
              close()
            }}
            className="focus-ring-inset flex h-8 items-center px-3 text-left text-ui text-graphite hover:bg-bone hover:text-foreground"
          >
            Any company or person
          </button>
        )
      }
      trigger={
        <button
          type="button"
          data-filter-picker="with"
          className="focus-ring flex h-7 w-50 shrink-0 items-center justify-between gap-1.5 rounded-md border border-hairline bg-paper pr-1.5 pl-2.5 text-left text-label text-foreground transition-colors duration-100 ease-out-quart hover:bg-bone"
        >
          <span className="min-w-0 truncate">{face}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0" />
        </button>
      }
    />
  )
}

/**
 * `Jump to`, on Past: the months that have meetings, newest first under
 * their years, each with its count. Choosing one reads Past from that month
 * down; while one holds, the button reads it and `Newest first` leads the
 * menu to read from the top again.
 */
export function JumpTo({
  read,
  month,
  onJump,
}: {
  read: FacetsRead
  /** The month Past is read from, `2026-09`; null for the top. */
  month: string | null
  onJump: (month: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const facets = useFacets(open, read)
  const years = monthsByYear(facets?.months ?? [])
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-tool="jump"
          className={cn(
            'focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui font-medium whitespace-nowrap text-foreground transition-colors duration-100 ease-out-quart hover:bg-bone data-[state=open]:bg-bone',
            month !== null && 'border border-hairline',
          )}
        >
          <Calendar aria-hidden className="size-4" />
          {month === null ? 'Jump to' : monthName(month)}
          <ChevronDown aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-50 p-0">
        {month === null ? null : (
          <DropdownMenuItem
            data-jump="newest"
            icon={<icon.sortDescending />}
            onSelect={() => onJump(null)}
            className="h-8 border-b border-rule px-3"
          >
            Newest first
          </DropdownMenuItem>
        )}
        {facets === null ? (
          <p className="flex h-8 items-center px-3 text-label text-graphite">
            Reading months…
          </p>
        ) : years.length === 0 ? (
          <p className="flex h-8 items-center px-3 text-label text-graphite">
            No past meetings.
          </p>
        ) : (
          years.map((y, i) => (
            <div key={y.year} role="group" aria-label={y.year}>
              <DropdownMenuLabel
                className={cn(
                  'flex h-7 items-center border-b border-rule bg-bone px-3 py-0 label-caps font-normal text-graphite',
                  (i > 0 || month !== null) && 'border-t',
                )}
              >
                {y.year}
              </DropdownMenuLabel>
              {y.months.map((m) => (
                <DropdownMenuItem
                  key={m.month}
                  data-jump={m.month}
                  icon={<MenuCheck checked={m.month === month} />}
                  onSelect={() => onJump(m.month)}
                  className={cn('h-8 px-3', m.month === month && 'font-medium')}
                >
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                  <span className="tabular shrink-0 mono text-micro text-graphite">
                    {m.count.toLocaleString('en-US')}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** How long the search waits after the last key before it reads again. */
const SEARCH_QUIET_MS = 250

/**
 * `Search titles and people`: the page's one search field and its one
 * typed text, handed to the address once typing pauses.
 */
export function MeetingsSearch({
  q,
  onSearch,
}: {
  /** The search the list was read with. */
  q: string
  /** Once typing pauses, with the trimmed text. */
  onSearch: (q: string) => void
}) {
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
  return (
    <SearchField
      value={text}
      onValueChange={setText}
      label="Search titles and people"
      placeholder="Search titles and people"
      slash
      className="w-65"
    />
  )
}
