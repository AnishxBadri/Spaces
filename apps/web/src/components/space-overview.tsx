import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cellsFor } from '#/components/dither'
import { Band, Day, EmptyRow } from '#/components/ledger-section'
import { DitherMark } from '#/components/record/record-parts'
import type { Space } from '#/components/space-tabs'
import { TasksBand } from '#/components/tasks-rail'
import type { SpaceHeadline, SpaceMoving, SpaceSignal } from '#/lib/server-fns'
import { recordPath } from '#/lib/record-path'
import { stageLabel, stageMix } from '#/lib/spaces/page'
import type { SpaceTab, StageSegment } from '#/lib/spaces/page'
import { cn } from '#/lib/utils'

/**
 * A space's Overview tab, the one it opens on, top to bottom: the readouts
 * that have a value, What's moving, the open tasks with their composer and
 * the latest companies — each group a band ending on its way out. A space
 * with nothing filed reads `Tasks +` and `Companies +` and nothing else.
 */

/** How many signals and companies Overview lists before its links. */
const LATEST = 3

/** One readout cell: a number or a day, or the funding-stage bar. */
export type SpaceReadout = { label: string; value: ReactNode }

/**
 * The readouts that have a value, never a tab's count: how many companies
 * here are in a pipeline, the last filing, and the funding-stage mix as the
 * page's one dither. A 0, a dash or an empty mix is left out.
 */
export function spaceReadouts(spc: Space, today: string): Array<SpaceReadout> {
  const inPipeline = spc.companies.filter((c) => c.deals > 0).length
  const segments = stageMix(
    spc.companies.map((c) => c.stage),
    spc.stageOptions,
  )
  const out: Array<SpaceReadout> = []
  if (inPipeline > 0)
    out.push({
      label: 'In pipeline',
      value: `${String(inPipeline)} of ${String(spc.companies.length)}`,
    })
  if (spc.lastFiled !== null)
    out.push({
      label: 'Last filed',
      value: formatDay(spc.lastFiled.on, today),
    })
  if (segments.length > 0)
    out.push({
      label: 'Funding stage',
      value: <StageBar segments={segments} />,
    })
  return out
}

export function SpaceOverview({
  spc,
  moving,
  hasFeeds,
  onTab,
}: {
  spc: Space
  moving: ReadonlyArray<SpaceMoving>
  /** A feed is tagged to the space or under it: the lane links to Headlines. */
  hasFeeds: boolean
  onTab: (tab: SpaceTab) => void
}) {
  const { today } = useClock()
  const readouts = spaceReadouts(spc, today)
  return (
    <div data-overview className="flex flex-col">
      {readouts.length > 0 ? (
        <div
          data-overview-readouts
          className="flex h-19 shrink-0 overflow-x-auto border-b border-rule px-(--inset)"
        >
          {readouts.map((r, i) => {
            const bar = typeof r.value !== 'string'
            return (
              <div
                key={r.label}
                data-readout
                className={cn(
                  'flex shrink-0 flex-col justify-center gap-0.5',
                  i === 0 ? 'w-55 border-r border-rule' : 'pl-4',
                  bar ? 'w-90 shrink' : i > 0 && 'w-45',
                )}
              >
                {bar ? (
                  <div className="flex h-6.5 min-w-0 items-end">{r.value}</div>
                ) : (
                  <span className="truncate mono text-page leading-6.5 text-foreground">
                    {r.value}
                  </span>
                )}
                <span className="truncate text-label text-graphite">
                  {r.label}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}

      <MovingGroup spaceId={spc.id} moving={moving} hasFeeds={hasFeeds} />

      <TasksBand entityId={spc.id} entityName={spc.name} entityKind="space" />

      {spc.companies.length === 0 ? (
        <EmptyRow name="Companies" onAdd={() => onTab('companies')} />
      ) : (
        <LatestCompanies spc={spc} onAll={() => onTab('companies')} />
      )}
    </div>
  )
}

/** A band's way out: sans graphite, ink on hover. */
function BandLink({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring hover:text-foreground"
    >
      {children}
    </button>
  )
}

/** What's moving shows this many rows before its `n more`. */
const MOVING_SHOWN = 4

/**
 * What's moving: the latest signals on the space's members and each feed's
 * newest two headlines, newest first, on two-line rows under a day lane.
 * Four show; the foot unfolds the rest in place (`9 more`) and, with a feed
 * tagged here, opens Feeds narrowed to the space (`Headlines ›`). Absent
 * while nothing has moved.
 */
function MovingGroup({
  spaceId,
  moving,
  hasFeeds,
}: {
  spaceId: string
  moving: ReadonlyArray<SpaceMoving>
  hasFeeds: boolean
}) {
  const [open, setOpen] = useState(false)
  if (moving.length === 0) return null
  const folded = moving.length - MOVING_SHOWN
  const shown = open ? moving : moving.slice(0, MOVING_SHOWN)
  return (
    <section aria-label="What's moving" className="flex flex-col">
      <Band label="What's moving" />
      <ul>
        {shown.map((m) =>
          m.kind === 'signal' ? (
            <SignalRow key={m.signal.id} s={m.signal} />
          ) : (
            <HeadlineRow key={m.headline.id} h={m.headline} />
          ),
        )}
      </ul>
      {folded > 0 || hasFeeds ? (
        <div
          data-moving-foot
          className="flex h-9 shrink-0 items-center justify-between gap-3 px-(--inset) text-label text-graphite"
        >
          {folded > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="focus-ring hover:text-foreground"
            >
              {open ? 'Fewer' : `${String(folded)} more`}
            </button>
          ) : (
            <span />
          )}
          {hasFeeds ? (
            <Link
              to="/feeds"
              search={{ space: spaceId }}
              className="focus-ring hover:text-foreground"
            >
              Headlines ›
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/**
 * One row of What's moving: the 44px day lane, then the title, wrapping to
 * two lines at most, over one graphite line cut to a single line.
 */
function MovingRow({
  at,
  title,
  sub,
  ...data
}: {
  at: string
  title: ReactNode
  sub: string
  'data-signal'?: string
  'data-headline'?: string
}) {
  const { today } = useClock()
  return (
    <li
      {...data}
      className="flex items-start gap-3 border-b border-rule px-(--inset) py-2.5"
    >
      <time
        dateTime={at}
        className="w-11 shrink-0 mono text-micro leading-5 text-graphite"
      >
        {formatDay(at, today)}
      </time>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title}
        <span data-moving-sub className="truncate text-label text-graphite">
          {sub}
        </span>
      </div>
    </li>
  )
}

// The title's own width, so the row's empty end is not a link.
const MOVING_TITLE =
  'focus-ring line-clamp-2 max-w-full self-start text-ui text-foreground'

/**
 * A signal: its headline, then the record, the subspace it is filed in when
 * not here directly, and where it was read.
 */
function SignalRow({ s }: { s: SpaceSignal }) {
  const href = recordPath({ kind: s.recordKind, id: s.recordId })
  const headline = s.title ?? s.kind ?? s.recordName
  const sub = [
    s.recordName,
    ...(s.via === null ? [] : [`in ${s.via.name}`]),
    `via ${s.source}`,
  ].join(' · ')
  return (
    <MovingRow
      data-signal={s.id}
      at={s.observedAt}
      sub={sub}
      title={
        href ? (
          <Link to={href} className={cn(MOVING_TITLE, 'hover:underline')}>
            {headline}
          </Link>
        ) : (
          <span className={MOVING_TITLE}>{headline}</span>
        )
      }
    />
  )
}

/** A feed's headline: the story, opened in a new tab, over its source and summary. */
function HeadlineRow({ h }: { h: SpaceHeadline }) {
  return (
    <MovingRow
      data-headline={h.id}
      at={h.publishedAt}
      sub={h.summary === null ? h.feedName : `${h.feedName} · ${h.summary}`}
      title={
        h.url !== null ? (
          <a
            href={h.url}
            target="_blank"
            rel="noreferrer"
            className={cn(MOVING_TITLE, 'hover:underline')}
          >
            {h.title}
          </a>
        ) : (
          <span className={MOVING_TITLE}>{h.title}</span>
        )
      }
    />
  )
}

/** The latest filings: the mark, the name, its stage and the day filed. */
function LatestCompanies({ spc, onAll }: { spc: Space; onAll: () => void }) {
  const latest = [...spc.companies]
    .sort((a, b) =>
      a.filedAt < b.filedAt ? 1 : a.filedAt > b.filedAt ? -1 : 0,
    )
    .slice(0, LATEST)
  return (
    <section aria-label="Latest companies" className="flex flex-col">
      <Band
        label="Latest companies"
        link={<BandLink onClick={onAll}>All companies ›</BandLink>}
      />
      <ul>
        {latest.map((c) => {
          const stage = stageLabel(c.stage, spc.stageOptions)
          return (
            <li
              key={c.id}
              data-company={c.id}
              className="flex h-ledger-row items-center gap-3 border-b border-rule px-(--inset)"
            >
              <DitherMark size={14} />
              <Link
                to="/companies/$companyId"
                params={{ companyId: c.id }}
                className="focus-ring min-w-0 flex-1 truncate text-ui font-medium text-foreground hover:underline"
              >
                {c.name}
              </Link>
              <span className="flex w-24 min-w-0 shrink-0">
                {stage ? (
                  <span className="flex h-5 min-w-0 items-center truncate bg-bone px-1.5 mono text-micro font-medium">
                    {stage}
                  </span>
                ) : null}
              </span>
              <Day at={c.filedAt} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

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
