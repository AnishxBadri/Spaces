import { Link, useRouter } from '@tanstack/react-router'
import { Boxes, FileText, X } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { FilterCount, FilterRow, FilterTab } from './filter-row'
import { FoldRow, LabelHead, LedgerFigure, LedgerRow } from './ledger-section'
import { DitherMark, InitialsMark } from './record/record-parts'
import { SpaceOverview } from './space-overview'
import { SpaceSources } from './space-sources'
import { TagCompanyRow } from './space-tag-row'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Segmented } from './ui/segmented'
import { Select } from './ui/select'
import { Tabs } from './ui/tabs'
import { SelectionBar } from './table/selection-bar'
import type { TabItem } from './ui/tabs'
import {
  COMPANY_FOLD,
  COMPANY_SORTS,
  SPACE_TABS,
  filterCompanies,
  foldStages,
  moveTarget,
  sortCompanies,
  spacePeople,
  stageLabel,
} from '#/lib/spaces/page'
import type { CompanyFilter, CompanySort, SpaceTab } from '#/lib/spaces/page'
import {
  moveIntoSubspace,
  tagIntoSpace,
  untagFromSpace,
} from '#/lib/server-fns'
import type { SpaceSignal, getSpace } from '#/lib/server-fns'
import { formatWhen } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

/**
 * The space page's view: the tab head over one tab, as a record's body is,
 * Overview first. Each tab owns its room — a switch where it has one, then
 * 40px rows on rules.
 */

export type Space = Awaited<ReturnType<typeof getSpace>>
type Company = Space['companies'][number]

/** The row's exit: long enough to read, short enough to ignore. */
const EXIT_MS = 150

const TAB_LABELS: Record<SpaceTab, string> = {
  overview: 'Overview',
  companies: 'Companies',
  notes: 'Notes',
  files: 'Files',
  people: 'People',
  records: 'Records',
}

type CountedTab = Exclude<SpaceTab, 'overview'>

/** Each listing tab's count: what the tab lists, so an empty one reads 0. */
export function spaceTabCounts(spc: Space): Record<CountedTab, number> {
  return {
    companies: spc.companies.length,
    notes: spc.filed.length + spc.notes.length,
    files: spc.sources.length,
    people: spacePeople(spc.contacts, spc.inheritedContacts).length,
    records: spc.records.length,
  }
}

export function SpaceTabs({
  spc,
  signals,
  tab,
  into,
  onTabChange,
  onNewNote,
}: {
  spc: Space
  /** What's moving on the space's members, for Overview. */
  signals: ReadonlyArray<SpaceSignal>
  tab: SpaceTab
  /** The subspace a split moves companies into, from the link. */
  into: string | null
  onTabChange: (tab: SpaceTab) => void
  onNewNote: (kind?: 'memo') => void
}) {
  const counts = spaceTabCounts(spc)
  const items: Array<TabItem<SpaceTab>> = SPACE_TABS.map((id) =>
    id === 'overview'
      ? { id, label: TAB_LABELS[id], uncounted: true }
      : { id, label: TAB_LABELS[id], count: counts[id] },
  )
  return (
    <Tabs
      label={spc.name}
      items={items}
      value={tab}
      onValueChange={onTabChange}
    >
      {tab === 'overview' ? (
        <SpaceOverview spc={spc} signals={signals} onTab={onTabChange} />
      ) : tab === 'companies' ? (
        <CompaniesTab spc={spc} into={into} />
      ) : tab === 'notes' ? (
        <NotesTab spc={spc} onNewNote={onNewNote} />
      ) : tab === 'files' ? (
        <SpaceSources
          spaceId={spc.id}
          spaceName={spc.name}
          sources={spc.sources}
          inherited={spc.inheritedSources}
        />
      ) : tab === 'people' ? (
        <PeopleTab spc={spc} />
      ) : (
        <RecordsTab spc={spc} />
      )}
    </Tabs>
  )
}

/**
 * Move here's selection bar, in place of the filter row: the subspace to
 * move into, and Move here as the one pine verb.
 */
function MoveBar({
  count,
  subspaces,
  target,
  onTarget,
  busy,
  onMove,
}: {
  count: number
  subspaces: ReadonlyArray<{ id: string; name: string }>
  target: string | null
  onTarget: (id: string) => void
  busy: boolean
  onMove: () => void
}) {
  return (
    <SelectionBar label="Selected companies" count={count}>
      <span className="shrink-0 text-ui text-graphite">into</span>
      <Select
        aria-label="Subspace to move into"
        width="content"
        value={target ?? ''}
        onChange={onTarget}
        placeholder="Subspace…"
        items={subspaces.map((s) => ({ value: s.id, label: s.name }))}
        className="h-7 w-auto min-w-0"
      />
      <span className="flex-1" />
      <Button size="sm" disabled={target === null || busy} onClick={onMove}>
        Move here
      </Button>
    </SelectionBar>
  )
}

/** One quiet row for a tab with nothing in it. */
function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <LedgerRow last>
      <span className="w-3.5 shrink-0 text-center mono text-ui text-graphite">
        —
      </span>
      <span className="min-w-0 flex-1 truncate text-ui text-graphite">
        {children}
      </span>
    </LedgerRow>
  )
}

const rowLink =
  'focus-ring-inset -ml-3 flex h-full min-w-0 flex-1 items-center gap-3 pl-3 transition-colors hover:bg-bone'

// ---------- Companies ----------

/** The Companies rows' fixed lanes, right of the name: 96 · 72 · 88. */
const LANES = {
  stage: 'w-24',
  pipeline: 'w-18',
  location: 'w-22',
} as const

/**
 * Sentence-case lane heads over the company rows, on the rows' own lanes:
 * the select box and the mark hold their width, the × its 24px.
 */
function CompanyLaneHeads({ selectable }: { selectable: boolean }) {
  return (
    <div
      aria-hidden
      data-lane-heads
      className="flex h-7 items-center gap-3 border-b border-rule px-3 text-label text-graphite"
    >
      {selectable ? <span className="w-3.5 shrink-0" /> : null}
      <span className="w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Company</span>
      <span className={cn(LANES.stage, 'shrink-0')}>Funding stage</span>
      <span className={cn(LANES.pipeline, 'shrink-0 text-right')}>
        Pipeline
      </span>
      <span className={cn(LANES.location, 'shrink-0 text-right max-md:hidden')}>
        Location
      </span>
      <span className="w-6 shrink-0" />
    </div>
  )
}

/**
 * The Companies tab: the All · In pipeline · Watching switch with Sort at
 * its right, the tag composer, then the rows, folded past `COMPANY_FOLD`
 * under a foot that counts the rest by stage. Its rows are this space's own
 * filings only — a company filed in a subspace is not listed, so a split
 * can only choose those.
 * - Selecting needs a subspace to move into; `into` opens it selecting.
 */
function CompaniesTab({ spc, into }: { spc: Space; into: string | null }) {
  const router = useRouter()
  const [filter, setFilter] = useState<CompanyFilter>('all')
  const [sort, setSort] = useState<CompanySort>('stage')
  // Chosen for Move here.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [picked, setPicked] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  // Companies mid-untag: faded until the write lands and the row unmounts.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const [unfolded, setUnfolded] = useState(false)

  const selectable = spc.children.length > 0
  const selecting = moveTarget(spc.children, null, into) !== null
  const target = moveTarget(spc.children, picked, into)
  const chosen = spc.companies.filter((c) => selected.has(c.id))

  const inPipeline = spc.companies.filter((c) => c.deals > 0).length
  const watching = spc.companies.length - inPipeline
  const sorted = sortCompanies(
    filterCompanies(spc.companies, filter),
    sort,
    spc.stageOptions,
  )
  const rows = unfolded ? sorted : sorted.slice(0, COMPANY_FOLD)
  const folded = sorted.slice(rows.length)
  const taggedIds = new Set(spc.companies.map((c) => c.id))

  async function retag(c: Company) {
    try {
      await tagIntoSpace({ data: { entityId: c.id, spaceId: spc.id } })
      void router.invalidate()
    } catch {
      toast.error(`Could not re-tag ${c.name}`)
    }
  }

  async function writeUntag(c: Company) {
    try {
      await untagFromSpace({ data: { entityId: c.id, spaceId: spc.id } })
      void router.invalidate()
      toast(`${c.name} untagged from ${spc.name}`, {
        action: { label: 'Undo', onClick: () => void retag(c) },
      })
    } catch {
      toast.error(`Could not untag ${c.name}`)
    } finally {
      setLeaving((s) => {
        const next = new Set(s)
        next.delete(c.id)
        return next
      })
    }
  }

  /** Untagging reads as the row leaving, not the list flinching. */
  function untag(c: Company) {
    toggle(c.id, false)
    setLeaving((s) => new Set(s).add(c.id))
    window.setTimeout(() => void writeUntag(c), EXIT_MS)
  }

  function toggle(id: string, on: boolean) {
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  /** Each chosen company is untagged here and tagged in the subspace. */
  async function moveHere() {
    const child = spc.children.find((c) => c.id === target)
    if (!child || chosen.length === 0) return
    setMoving(true)
    try {
      const { moved } = await moveIntoSubspace({
        data: {
          fromSpaceId: spc.id,
          toSpaceId: child.id,
          entityIds: chosen.map((c) => c.id),
        },
      })
      setSelected(new Set())
      void router.invalidate()
      toast(
        `${moved} compan${moved === 1 ? 'y' : 'ies'} moved to ${child.name}`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not move')
    } finally {
      setMoving(false)
    }
  }

  return (
    <div className="flex flex-col">
      {chosen.length > 0 ? (
        <MoveBar
          count={chosen.length}
          subspaces={spc.children}
          target={target}
          onTarget={setPicked}
          busy={moving}
          onMove={() => void moveHere()}
        />
      ) : (
        <div
          data-companies-bar
          className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-rule px-3"
        >
          <Segmented
            label="Show companies"
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'all', label: 'All' },
              { id: 'pipeline', label: 'In pipeline', count: inPipeline },
              { id: 'watching', label: 'Watching', count: watching },
            ]}
          />
          <span className="flex items-center gap-1.5 text-label text-graphite">
            Sort
            <Select
              aria-label="Sort companies"
              width="content"
              value={sort}
              onChange={setSort}
              items={COMPANY_SORTS.map((s) => ({
                value: s.id,
                label: s.label,
              }))}
              className="h-7 w-auto border-transparent bg-transparent px-1 text-label text-foreground hover:border-transparent"
            />
          </span>
        </div>
      )}
      <ol>
        <TagCompanyRow
          spaceId={spc.id}
          spaceName={spc.name}
          taggedIds={taggedIds}
        />
      </ol>
      {spc.companies.length > 0 ? (
        <CompanyLaneHeads selectable={selectable} />
      ) : null}
      <ol>
        {rows.map((c, i) => {
          const stage = stageLabel(c.stage, spc.stageOptions)
          const on = selected.has(c.id)
          return (
            <LedgerRow
              key={c.id}
              last={i === rows.length - 1}
              className={cn(
                'group transition-opacity duration-150 ease-out-quart',
                leaving.has(c.id) && 'pointer-events-none opacity-0',
              )}
            >
              {selectable ? (
                <Checkbox
                  checked={on}
                  onCheckedChange={(next) => toggle(c.id, next)}
                  aria-label={`Select ${c.name}`}
                  className={cn(
                    'shrink-0 group-hover:opacity-100 focus-visible:opacity-100',
                    on || selecting ? 'opacity-100' : 'opacity-0',
                  )}
                />
              ) : null}
              <Link
                to="/companies/$companyId"
                params={{ companyId: c.id }}
                className={rowLink}
              >
                <DitherMark size={14} />
                <span className="min-w-0 flex-1 truncate text-body font-medium">
                  {c.name}
                </span>
                <span className={cn(LANES.stage, 'flex min-w-0 shrink-0')}>
                  {stage ? (
                    <span className="flex h-5 min-w-0 items-center truncate bg-bone px-1.5 mono text-micro font-medium">
                      {stage}
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    LANES.pipeline,
                    'shrink-0 truncate text-right mono text-micro',
                    c.deals > 0 ? 'text-foreground' : 'text-graphite',
                  )}
                >
                  {c.deals > 0
                    ? `${c.deals} deal${c.deals === 1 ? '' : 's'}`
                    : 'watching'}
                </span>
                <span
                  className={cn(
                    LANES.location,
                    'shrink-0 truncate text-right mono text-label text-graphite max-md:hidden',
                  )}
                >
                  {c.geo ?? ''}
                </span>
              </Link>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Untag ${c.name} from ${spc.name}`}
                onClick={() => untag(c)}
                className="shrink-0 text-graphite opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
              >
                <X />
              </Button>
            </LedgerRow>
          )
        })}
        {rows.length === 0 && spc.companies.length > 0 ? (
          <EmptyRow>
            {filter === 'pipeline'
              ? 'None in a pipeline.'
              : 'Every company here is in a pipeline.'}
          </EmptyRow>
        ) : null}
      </ol>
      {folded.length > 0 ? (
        <FoldRow
          hidden={folded.length}
          detail={foldStages(
            folded.map((c) => c.stage),
            spc.stageOptions,
          )}
          onShow={() => setUnfolded(true)}
        />
      ) : null}
    </div>
  )
}

// ---------- Notes ----------

type NotesFilter = 'all' | 'filed' | 'mentions'

/**
 * Filed here on purpose, or only mentioning the space from elsewhere; All
 * lists the filed notes, then the mentions under their own label.
 * - An archived space's rows go graphite, as its name does.
 */
function NotesTab({
  spc,
  onNewNote,
}: {
  spc: Space
  onNewNote: (kind?: 'memo') => void
}) {
  const [filter, setFilter] = useState<NotesFilter>('all')
  const { now } = useClock()
  const archived = spc.archive !== null || spc.archivedUnder !== null
  const ink = archived ? 'text-graphite' : undefined
  return (
    <div className="flex flex-col">
      <FilterRow label="Show notes">
        <FilterTab active={filter === 'all'} onClick={() => setFilter('all')}>
          All <FilterCount n={spc.filed.length + spc.notes.length} />
        </FilterTab>
        <FilterTab
          active={filter === 'filed'}
          onClick={() => setFilter('filed')}
        >
          Filed here <FilterCount n={spc.filed.length} />
        </FilterTab>
        <FilterTab
          active={filter === 'mentions'}
          onClick={() => setFilter('mentions')}
        >
          Mentions <FilterCount n={spc.notes.length} />
        </FilterTab>
      </FilterRow>
      {filter !== 'mentions' ? (
        <ol>
          {spc.filed.map((f) => (
            <li key={f.id} className="border-b border-rule">
              <Link
                to="/notes/$noteId"
                params={{ noteId: f.id }}
                className="focus-ring-inset flex flex-col gap-2 px-3 py-4 transition-colors hover:bg-bone"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3
                    className={cn(
                      'min-w-0 truncate text-title font-medium',
                      ink,
                    )}
                  >
                    {f.title || `${spc.name} ${f.kind}`}
                  </h3>
                  <span className="shrink-0 mono text-label text-graphite">
                    {f.kind} · updated {formatWhen(f.updatedAt, now)}
                  </span>
                </div>
                {f.snippet ? (
                  <p className="text-prose max-w-160 font-serif leading-6.75 text-graphite">
                    {f.snippet}
                    {f.snippet.length >= 400 ? '…' : ''}
                  </p>
                ) : (
                  <p className="text-ui text-graphite">
                    Empty so far — open it and set down what you know.
                  </p>
                )}
              </Link>
            </li>
          ))}
          <LedgerRow last>
            <button
              type="button"
              onClick={() =>
                onNewNote(spc.filed.length === 0 ? 'memo' : undefined)
              }
              className={cn(rowLink, '-mr-3 pr-3 text-left')}
            >
              <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
                +
              </span>
              <span className="min-w-0 flex-1 truncate text-body text-graphite">
                {spc.filed.length === 0 ? 'Write the memo…' : 'File another…'}
              </span>
              <span className="shrink-0 text-graphite">
                <kbd className="shrink-0 mono text-micro text-graphite">N</kbd>
              </span>
            </button>
          </LedgerRow>
        </ol>
      ) : null}
      {filter === 'all' && spc.notes.length > 0 ? (
        <LabelHead label="Mentions · filed elsewhere" className="border-t">
          <span className="mono text-micro text-graphite">
            {spc.notes.length}
          </span>
        </LabelHead>
      ) : null}
      {filter !== 'filed' ? (
        <ol>
          {spc.notes.length === 0 && filter === 'mentions' ? (
            <EmptyRow>No note elsewhere mentions {spc.name}.</EmptyRow>
          ) : null}
          {spc.notes.map((n, i) => (
            <LedgerRow key={n.id} last={i === spc.notes.length - 1}>
              <Link
                to="/notes/$noteId"
                params={{ noteId: n.id }}
                className={cn(rowLink, '-mr-3 pr-3')}
              >
                <FileText
                  className="size-3.5 shrink-0 text-graphite"
                  strokeWidth={1.75}
                />
                <span className={cn('min-w-0 flex-1 truncate text-body', ink)}>
                  {n.title}
                </span>
                <LedgerFigure tone="muted">
                  {formatWhen(n.updatedAt, now)}
                </LedgerFigure>
              </Link>
            </LedgerRow>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

// ---------- People ----------

function PeopleTab({ spc }: { spc: Space }) {
  const people = spacePeople(spc.contacts, spc.inheritedContacts)
  return (
    <ol>
      {people.length === 0 ? (
        <EmptyRow>No one at the companies filed here yet.</EmptyRow>
      ) : (
        people.map((p, i) => {
          const meta = [
            p.person.headline,
            p.kind === 'company' ? p.via : 'filed here',
          ]
            .filter(Boolean)
            .join(' · ')
          return (
            <LedgerRow key={p.person.id} last={i === people.length - 1}>
              <Link
                to="/people/$personId"
                params={{ personId: p.person.id }}
                className={cn(rowLink, '-mr-3 pr-3')}
              >
                <InitialsMark name={p.person.name} outline />
                <span className="min-w-0 flex-1 truncate text-body font-medium">
                  {p.person.name}
                </span>
                <span className="min-w-0 shrink truncate text-right mono text-micro text-graphite">
                  {meta}
                </span>
              </Link>
            </LedgerRow>
          )
        })
      )}
    </ol>
  )
}

// ---------- Records ----------

function RecordsTab({ spc }: { spc: Space }) {
  return (
    <ol>
      {spc.records.length === 0 ? (
        <EmptyRow>No custom records filed here.</EmptyRow>
      ) : (
        spc.records.map((r, i) => (
          <LedgerRow key={r.id} last={i === spc.records.length - 1}>
            <Link
              to="/o/$objectSlug/$recordId"
              params={{ objectSlug: r.objectSlug, recordId: r.id }}
              className={cn(rowLink, '-mr-3 pr-3')}
            >
              <Boxes
                className="size-3.5 shrink-0 text-foreground"
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-body font-medium">
                {r.name}
              </span>
              <LedgerFigure tone="muted" wide>
                {r.objectPlural}
              </LedgerFigure>
            </Link>
          </LedgerRow>
        ))
      )}
    </ol>
  )
}
