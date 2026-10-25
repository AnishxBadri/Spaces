import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { MeetingDialog } from '#/components/meeting-dialog'
import { KeyHint, PageHeader } from '#/components/page-header'
import { ReadoutStrip } from '#/components/record/record-parts'
import { DayStrip, useNow } from '#/components/today/day-strip'
import { FirstRun } from '#/components/today/first-run'
import { MeetingsSection, useDayMeetings } from '#/components/today/meetings'
import { NeedsYou } from '#/components/today/needs-you'
import type { NeedsYouRow, StageBadge } from '#/components/today/needs-you'
import { NoticesBand } from '#/components/today/notices'
import {
  PortfolioRail,
  TeamActivity,
  unpricedCurrencies,
  WhatsMoving,
} from '#/components/today/rail'
import { todayReadouts } from '#/components/today/readouts'
import { Button } from '#/components/ui/button'
import { useBornRows } from '#/lib/born-rows'
import {
  countCompanies,
  countUnfiledDocuments,
  dealFunnelStats,
  getTodayAttention,
  getTodayMeetings,
  getWorkspaceActivity,
  listHoldings,
  listRegistry,
  listStoppedPlugins,
  listTasks,
  setTaskDone,
} from '#/lib/server-fns'
import {
  byUrgency,
  daysBetween,
  daysPastMedian,
  dealsPastMedian,
  IDLE_DEAL_DAYS,
  idleDeals,
  medianOf,
  STALE_MARK_DAYS,
  todayStamp,
} from '#/lib/today/needs-you'
import { localToday } from '@spaces/core/tasks/parse-due'
import { isoDay } from '#/lib/meetings/day'
import { modalSearch, openModalId } from '#/lib/modal-search'
import { GLOBAL_ACTIONS, runBinding, usePageActions } from '#/lib/page-actions'

const DAY_MS = 86_400_000

/**
 * Today: the one surface that gathers what needs the reader — tasks, idle
 * deals, stale marks and Review — in one ranked ledger, with what stops the
 * machine above it and the portfolio and what's moving beside it.
 * With no company yet it is the three ways in and nothing else.
 */
export const Route = createFileRoute('/_app/today')({
  validateSearch: modalSearch,
  loader: () => loadToday(),
  component: TodayPage,
})

async function loadToday() {
  if ((await countCompanies()) === 0)
    return {
      empty: true as const,
      registry: await listRegistry({ data: { kind: 'company' } }),
    }
  const [
    tasks,
    holdings,
    funnel,
    activity,
    dealRegistry,
    unfiledCount,
    stoppedPlugins,
    attention,
    meetings,
  ] = await Promise.all([
    listTasks(),
    listHoldings(),
    dealFunnelStats(),
    getWorkspaceActivity(),
    listRegistry({ data: { kind: 'deal' } }),
    // One number, from the predicate `/files?filed=unfiled` filters with.
    countUnfiledDocuments(),
    listStoppedPlugins(),
    getTodayAttention(),
    getTodayMeetings(),
  ])
  const since = Date.now() - DAY_MS
  return {
    empty: false as const,
    tasks,
    holdings,
    funnel,
    team: activity.filter((a) => Date.parse(a.at) >= since),
    dealRegistry,
    unfiledCount,
    stoppedPlugins,
    attention,
    meetings,
  }
}

/** The when-lane of a due row: −2d, today, or the ISO date. */
function dueFigure(due: string, today: string): string {
  const d = daysBetween(today, due)
  if (d === 0) return 'today'
  if (d < 0) return `−${-d}d`
  return due
}

type Loaded = Awaited<ReturnType<typeof loadToday>>

/** A past meeting's age in the reader's days: `today`, `2d`. */
function meetingAge(startsAt: string, now: Date): string {
  const ago = Math.max(0, daysBetween(isoDay(new Date(startsAt)), isoDay(now)))
  return ago === 0 ? 'today' : `${ago}d`
}

/** The date line above the title — `Sat 10-10 · W41`, as written, not caps. */
function DateLine({ today }: { today: string }) {
  return (
    <span className="tracking-normal normal-case">{todayStamp(today)}</span>
  )
}

/** The head: the date line, the plain title, and the day's two verbs. */
function TodayHead({ today, action }: { today: string; action?: ReactNode }) {
  return (
    <PageHeader
      eyebrow={<DateLine today={today} />}
      title="Today"
      {...(action ? { action } : {})}
    />
  )
}

function TodayPage() {
  const data = Route.useLoaderData()
  const today = localToday()
  if (data.empty)
    return (
      <div className="flex min-h-full flex-col">
        <TodayHead today={today} />
        <FirstRun registry={data.registry} />
      </div>
    )
  return <TodayLedger data={data} today={today} />
}

function TodayLedger({
  data,
  today,
}: {
  data: Extract<Loaded, { empty: false }>
  today: string
}) {
  const router = useRouter()
  usePageActions([
    { id: 'task', label: 'New task', key: 'T', run: runBinding('T') },
    { id: 'log', label: 'Log interaction', key: 'L', run: runBinding('L') },
    ...GLOBAL_ACTIONS,
  ])
  const {
    tasks,
    holdings,
    funnel,
    team,
    dealRegistry,
    unfiledCount,
    stoppedPlugins,
    attention,
    meetings,
  } = data
  // The composer row reports what it made; the wash is for arrivals only.
  const { washes, bear } = useBornRows()

  // The window opens from the URL, so a row and `?modal=meeting&id=` agree.
  const search = Route.useSearch()
  const go = Route.useNavigate()
  const meetingId = openModalId(search, 'meeting')
  const [prepFor, setPrepFor] = useState<string | null>(null)
  const openMeeting = (id: string, prep = false) => {
    setPrepFor(prep ? id : null)
    void go({
      search: (prev) => ({ ...prev, modal: 'meeting', id }),
      resetScroll: false,
    })
  }
  const closeMeeting = () => {
    setPrepFor(null)
    void go({
      search: (prev) => ({ ...prev, modal: undefined, id: undefined }),
      resetScroll: false,
    })
  }

  // The section's day moves with ‹ ›; the strip always shows today.
  const [day, setDay] = useState(today)
  const [version, setVersion] = useState(0)
  const todays = useDayMeetings(meetings.calendar ? today : null, version)
  const other = useDayMeetings(
    meetings.calendar && day !== today ? day : null,
    version,
  )
  const shown = day === today ? todays : other
  // A meeting's day is the reader's, so its age waits for the browser clock.
  const now = useNow()

  const dueTasks = tasks.open.filter((t) => t.dueDate && t.dueDate <= today)
  const overdue = dueTasks.filter((t) => t.dueDate && t.dueDate < today).length

  // Live holdings: priced, not written off, with money in.
  const live = holdings.holdings.flatMap((h) => {
    if (!h.metrics.ok) return []
    const m = h.metrics.metrics
    if (m.writtenOff || m.costBasis === 0) return []
    return [{ id: h.id, company: h.companyName, lastMark: m.lastMarkDate }]
  })
  const staleCutoff = new Date(Date.now() - STALE_MARK_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10)
  const stale = live.filter(
    (h) => h.lastMark === null || h.lastMark < staleCutoff,
  )
  const marked = live.flatMap((h) => (h.lastMark === null ? [] : [h.lastMark]))
  const oldestMark = marked.length === 0 ? null : marked.sort()[0]
  const oldestAge = oldestMark === null ? null : daysBetween(oldestMark, today)

  const stageOptions =
    dealRegistry.find((d) => d.slug === 'stage')?.options.options ?? []
  const activeStages = new Set(
    stageOptions
      .filter((o) => (o.group ?? 'active') === 'active')
      .map((o) => o.id),
  )
  // The stage pill reads the same option row the board reads, so both
  // surfaces land on the same hue; a retired stage reads as history.
  const stageBadge = (id: string): StageBadge => {
    const idx = stageOptions.findIndex((o) => o.id === id)
    const option = idx >= 0 ? stageOptions[idx] : undefined
    return {
      option,
      index: Math.max(idx, 0),
      archived: Boolean(option?.archived),
      label: option?.label ?? id,
    }
  }
  const medians = funnel.medianDaysInStage
  const pastMedian = dealsPastMedian(
    funnel.daysInStage,
    medians,
    activeStages,
  ).length

  const rows = byUrgency<NeedsYouRow>([
    ...dueTasks.map((t): NeedsYouRow => ({
      kind: 'task',
      key: `task:${t.id}`,
      weight: t.dueDate ? daysBetween(t.dueDate, today) : 0,
      id: t.id,
      content: t.content,
      record: t.entities[0]?.name ?? null,
      assignee: t.assigneeName,
      due: t.dueDate ? dueFigure(t.dueDate, today) : '—',
      late: !!t.dueDate && t.dueDate < today,
    })),
    ...idleDeals(funnel.daysInStage, medians, activeStages).map(
      (d): NeedsYouRow => ({
        kind: 'deal',
        key: `deal:${d.id}`,
        weight: daysPastMedian(d, medians) ?? (d.days ?? 0) - IDLE_DEAL_DAYS,
        id: d.id,
        name: d.name,
        days: Math.round(d.days ?? 0),
        median: medianOf(d.stage, medians),
        stage: stageBadge(d.stage),
      }),
    ),
    ...stale.map((h): NeedsYouRow => {
      const age = h.lastMark === null ? null : daysBetween(h.lastMark, today)
      return {
        kind: 'mark',
        key: `mark:${h.id}`,
        // Never marked is the stalest a holding can be.
        weight: age ?? Number.MAX_SAFE_INTEGER,
        holdingId: h.id,
        company: h.company,
        lastMark: h.lastMark,
        age,
      }
    }),
    ...attention.review.map((g): NeedsYouRow => ({
      kind: 'review',
      key: `review:${g.key}`,
      weight: g.total,
      group: g,
    })),
    ...meetings.unwritten.map((m): NeedsYouRow => ({
      kind: 'meeting',
      key: `meeting:${m.id}`,
      // Oldest first, from the instant alone: the same order on server and client.
      weight: -Date.parse(m.startsAt),
      id: m.id,
      title: m.title ?? 'Meeting',
      record: m.record,
      age: now === null ? null : meetingAge(m.startsAt, now),
    })),
  ])

  async function complete(id: string) {
    try {
      await setTaskDone({ data: { id, done: true } })
      void router.invalidate()
    } catch {
      toast.error('Could not update the task')
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <TodayHead
        today={today}
        action={
          <>
            {/* The ledger's composer owns T; the button presses it. */}
            <Button variant="outline" onClick={runBinding('T')}>
              New task
              <KeyHint>T</KeyHint>
            </Button>
            <LogInteractionDialog
              hotkey="l"
              trigger={
                <Button>
                  Log interaction
                  <KeyHint>L</KeyHint>
                </Button>
              }
            />
          </>
        }
      />
      <DayStrip
        meetings={(todays === null || todays === 'failed' ? [] : todays)
          .filter((m) => !m.cancelled)
          .map((m) => ({
            id: m.id,
            title: m.title ?? 'Meeting',
            startsAt: m.startsAt,
            endsAt: m.endsAt,
          }))}
      />
      <div className="border-y border-hairline px-8">
        <ReadoutStrip
          className="border-t-0"
          readouts={todayReadouts({
            overdue,
            pastMedian,
            oldestMarkAge: oldestAge,
            unfiled: unfiledCount,
          })}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-6 px-8 pt-6 pb-10">
          <MeetingsSection
            calendar={meetings.calendar}
            audience={meetings.audience}
            today={today}
            day={day}
            onDay={setDay}
            meetings={shown}
            onOpen={openMeeting}
            onRetry={() => setVersion((v) => v + 1)}
          />
          <NoticesBand
            stopped={stoppedPlugins}
            broken={attention.broken}
            parked={attention.parked}
            waiting={attention.waiting}
            failing={attention.failing}
          />
          <NeedsYou
            rows={rows}
            today={today}
            onComplete={(id) => void complete(id)}
            onOpenMeeting={(id) => openMeeting(id)}
            onCreated={bear}
            washes={washes}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col border-t border-hairline bg-bone xl:w-100 xl:border-t-0 xl:border-l">
          {holdings.holdings.length > 0 ? (
            <PortfolioRail
              rollup={holdings.rollup}
              baseCurrency={holdings.baseCurrency}
              holdingCount={holdings.holdings.length}
              missing={unpricedCurrencies(
                holdings.holdings,
                holdings.rollup.excludedForMissingRates,
              )}
            />
          ) : null}
          <WhatsMoving signals={attention.moving} today={today} />
          <TeamActivity entries={team} today={today} />
        </aside>
      </div>
      <MeetingDialog
        id={meetingId}
        prepOnOpen={prepFor !== null && prepFor === meetingId}
        onOpenChange={(open) => {
          if (!open) closeMeeting()
        }}
        onChanged={() => {
          setVersion((v) => v + 1)
          void router.invalidate()
        }}
      />
    </div>
  )
}
