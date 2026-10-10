import { Link, useRouter } from '@tanstack/react-router'
import { Boxes, FileText, X } from 'lucide-react'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { cellsFor } from './dither'
import { LedgerFigure, LedgerRow } from './ledger-section'
import { KeyHint } from './page-header'
import { DitherMark, InitialsMark } from './record/record-parts'
import type { RecordReadout } from './record/record-parts'
import { SpaceSources } from './space-sources'
import { TagCompanyRow } from './space-tag-row'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Select } from './ui/select'
import { Tabs } from './ui/tabs'
import type { TabItem } from './ui/tabs'
import {
  COMPANY_SORTS,
  SPACE_TABS,
  filterCompanies,
  moveTarget,
  sortCompanies,
  spacePeople,
  stageLabel,
  stageMix,
} from '#/lib/spaces/page'
import type {
  CompanyFilter,
  CompanySort,
  SpaceTab,
  StageSegment,
} from '#/lib/spaces/page'
import {
  moveIntoSubspace,
  tagIntoSpace,
  untagFromSpace,
} from '#/lib/server-fns'
import type { getSpace } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * The space page's view: the tab head over one tab, as a record's body is
 * (D73, D74). Each tab owns its room — a filter row in the underline
 * grammar where it has one, then 40px rows on rules.
 */

export type Space = Awaited<ReturnType<typeof getSpace>>
type Company = Space['companies'][number]

/** The row's exit: long enough to read, short enough to ignore. */
const EXIT_MS = 150

const TAB_LABELS: Record<SpaceTab, string> = {
  companies: 'Companies',
  notes: 'Notes',
  files: 'Files',
  people: 'People',
  records: 'Records',
}

/** Each tab's count: what the tab lists, so an empty one reads 0. */
export function spaceTabCounts(spc: Space): Record<SpaceTab, number> {
  return {
    companies: spc.companies.length,
    notes: spc.filed.length + spc.notes.length,
    files: spc.sources.length,
    people: spacePeople(spc.contacts, spc.inheritedContacts).length,
    records: spc.records.length,
  }
}

/**
 * The head's three readouts, never a tab's count: in pipeline, last filed,
 * and the funding-stage mix as the page's one dither.
 */
export function spaceReadouts(spc: Space): Array<RecordReadout> {
  const inPipeline = spc.companies.filter((c) => c.deals > 0).length
  const segments = stageMix(
    spc.companies.map((c) => c.stage),
    spc.stageOptions,
  )
  return [
    {
      label: 'In pipeline',
      value: `${inPipeline} of ${spc.companies.length}`,
      tone: inPipeline === 0 ? 'muted' : undefined,
    },
    {
      label: 'Last filed',
      value: spc.lastFiled
        ? `${spc.lastFiled.on.slice(5, 10)} · ${spc.lastFiled.days}d`
        : '—',
    },
    segments.length > 0
      ? {
          label: 'Funding stage',
          value: <StageBar segments={segments} />,
          figure: true,
        }
      : { label: 'Funding stage', value: '—' },
  ]
}

export function SpaceTabs({
  spc,
  tab,
  into,
  onTabChange,
  onNewNote,
}: {
  spc: Space
  tab: SpaceTab
  /** The subspace a split moves companies into, from the link. */
  into: string | null
  onTabChange: (tab: SpaceTab) => void
  onNewNote: (kind?: 'memo') => void
}) {
  const counts = spaceTabCounts(spc)
  const items: Array<TabItem<SpaceTab>> = SPACE_TABS.map((id) => ({
    id,
    label: TAB_LABELS[id],
    count: counts[id],
  }))
  return (
    <Tabs
      label={spc.name}
      size="head"
      items={items}
      value={tab}
      onValueChange={onTabChange}
    >
      {tab === 'companies' ? (
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

// ---------- the filter row ----------

/** A filter in the underline grammar: pine 2px under the chosen one. */
function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'focus-ring-inset flex h-9 items-center gap-1.5 border-b-2 px-3 label-caps transition-colors duration-150 ease-out-quart',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-graphite hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function FilterRow({
  label,
  children,
  end,
}: {
  label: string
  children: ReactNode
  end?: ReactNode
}) {
  return (
    <div className="flex h-11 items-end justify-between gap-3 border-b border-rule px-3">
      <div role="group" aria-label={label} className="-ml-3 flex items-end">
        {children}
      </div>
      {end ? <div className="flex h-full items-center">{end}</div> : null}
    </div>
  )
}

/**
 * The selection bar: the filter row's 44px on bone while a row is checked —
 * the count, the subspace to move into, and Move here as the one pine verb.
 */
function SelectionBar({
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
    <div
      role="toolbar"
      aria-label="Selected companies"
      data-selection-bar
      className="flex h-11 items-center gap-3 border-b border-rule bg-bone px-3"
    >
      <span className="tabular shrink-0 mono text-label">{count} selected</span>
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
    </div>
  )
}

function Count({ n }: { n: number }) {
  return <span className="tabular mono text-micro font-normal">{n}</span>
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

/**
 * The Companies tab. Its rows are this space's own filings only — a company
 * filed in a subspace is not listed, so a split can only choose those.
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

  const selectable = spc.children.length > 0
  const selecting = moveTarget(spc.children, null, into) !== null
  const target = moveTarget(spc.children, picked, into)
  const chosen = spc.companies.filter((c) => selected.has(c.id))

  const inPipeline = spc.companies.filter((c) => c.deals > 0).length
  const watching = spc.companies.length - inPipeline
  const rows = sortCompanies(
    filterCompanies(spc.companies, filter),
    sort,
    spc.stageOptions,
  )
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
        <SelectionBar
          count={chosen.length}
          subspaces={spc.children}
          target={target}
          onTarget={setPicked}
          busy={moving}
          onMove={() => void moveHere()}
        />
      ) : (
        <FilterRow
          label="Show companies"
          end={
            <Select
              aria-label="Sort companies"
              width="content"
              value={sort}
              onChange={setSort}
              items={COMPANY_SORTS.map((s) => ({
                value: s.id,
                label: s.label,
              }))}
              className="h-7 w-auto"
            />
          }
        >
          <FilterTab active={filter === 'all'} onClick={() => setFilter('all')}>
            All <Count n={spc.companies.length} />
          </FilterTab>
          <FilterTab
            active={filter === 'pipeline'}
            onClick={() => setFilter('pipeline')}
          >
            In pipeline <Count n={inPipeline} />
          </FilterTab>
          <FilterTab
            active={filter === 'watching'}
            onClick={() => setFilter('watching')}
          >
            Watching <Count n={watching} />
          </FilterTab>
        </FilterRow>
      )}
      <ol>
        <TagCompanyRow
          spaceId={spc.id}
          spaceName={spc.name}
          taggedIds={taggedIds}
        />
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
                {stage ? (
                  <span className="flex h-5 shrink-0 items-center bg-bone px-1.5 mono text-micro font-medium">
                    {stage}
                  </span>
                ) : null}
                <span
                  className={cn(
                    'w-20 shrink-0 truncate text-right mono text-micro',
                    c.deals > 0 ? 'text-foreground' : 'text-graphite',
                  )}
                >
                  {c.deals > 0
                    ? `${c.deals} deal${c.deals === 1 ? '' : 's'}`
                    : 'watching'}
                </span>
                <span className="w-24 shrink-0 truncate text-right mono text-label text-graphite max-md:hidden">
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
    </div>
  )
}

// ---------- Notes ----------

type NotesFilter = 'filed' | 'mentions'

/** Filed here on purpose, or only mentioning the space from elsewhere. */
function NotesTab({
  spc,
  onNewNote,
}: {
  spc: Space
  onNewNote: (kind?: 'memo') => void
}) {
  const [filter, setFilter] = useState<NotesFilter>('filed')
  return (
    <div className="flex flex-col">
      <FilterRow label="Show notes">
        <FilterTab
          active={filter === 'filed'}
          onClick={() => setFilter('filed')}
        >
          Filed <Count n={spc.filed.length} />
        </FilterTab>
        <FilterTab
          active={filter === 'mentions'}
          onClick={() => setFilter('mentions')}
        >
          Mentions <Count n={spc.notes.length} />
        </FilterTab>
      </FilterRow>
      {filter === 'filed' ? (
        <ol>
          {spc.filed.map((f) => (
            <li key={f.id} className="border-b border-rule">
              <Link
                to="/notes/$noteId"
                params={{ noteId: f.id }}
                className="focus-ring-inset flex flex-col gap-2 px-3 py-4 transition-colors hover:bg-bone"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="min-w-0 truncate text-title font-medium">
                    {f.title || `${spc.name} ${f.kind}`}
                  </h3>
                  <span className="shrink-0 mono text-label text-graphite">
                    {f.kind} · updated {f.updatedAt.slice(5, 10)}
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
                <KeyHint>N</KeyHint>
              </span>
            </button>
          </LedgerRow>
        </ol>
      ) : (
        <ol>
          {spc.notes.length === 0 ? (
            <EmptyRow>No note elsewhere mentions {spc.name}.</EmptyRow>
          ) : (
            spc.notes.map((n, i) => (
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
                  <span className="min-w-0 flex-1 truncate text-body">
                    {n.title}
                  </span>
                  <LedgerFigure tone="muted">
                    {n.updatedAt.slice(5, 10)}
                  </LedgerFigure>
                </Link>
              </LedgerRow>
            ))
          )}
        </ol>
      )}
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

// ---------- the funding-stage bar ----------

/**
 * The funding-stage mix: one segment per stage, as wide as its count, its
 * label under it. The page's one dither — density rises with stage and
 * bootstrapped draws lightest; companies with no stage are an outline.
 */
export function StageBar({ segments }: { segments: Array<StageSegment> }) {
  const base = useId().replace(/[^a-zA-Z0-9]/g, '')
  return (
    <div data-stage-bar className="flex w-full min-w-0 flex-col gap-1">
      <div className="flex h-2 w-full gap-px" aria-hidden>
        {segments.map((s, i) =>
          s.level === 0 ? (
            <span
              key={s.id ?? 'none'}
              className="h-2 min-w-1 basis-0 border border-hairline"
              style={{ flexGrow: s.count }}
            />
          ) : (
            <svg
              key={s.id ?? 'none'}
              height="8"
              className="h-2 min-w-1 basis-0"
              style={{ flexGrow: s.count }}
            >
              <defs>
                <pattern
                  id={`${base}-stage-${i}`}
                  width="8"
                  height="8"
                  patternUnits="userSpaceOnUse"
                  shapeRendering="crispEdges"
                >
                  {cellsFor(s.level).map(([x, y]) => (
                    <rect
                      key={`${x}-${y}`}
                      x={x}
                      y={y}
                      width="2"
                      height="2"
                      fill="var(--primary)"
                    />
                  ))}
                </pattern>
              </defs>
              <rect width="100%" height="8" fill={`url(#${base}-stage-${i})`} />
            </svg>
          ),
        )}
      </div>
      <ol className="flex w-full gap-px" aria-label="Funding stages">
        {segments.map((s) => (
          <li
            key={s.id ?? 'none'}
            data-stage={s.id ?? ''}
            title={`${s.label} · ${s.count}`}
            className="min-w-1 basis-0 truncate mono text-micro leading-3.5 text-graphite"
            style={{ flexGrow: s.count }}
          >
            {s.label} <span className="text-foreground">{s.count}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
