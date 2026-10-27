import {
  createFileRoute,
  useRouteContext,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { MeetingDialog } from '#/components/meeting-dialog'
import { PageHeader } from '#/components/page-header'
import { ReadoutStrip } from '#/components/record/record-parts'
import { useTaskMenu } from '#/components/tasks/task-menu'
import { DayStrip, useNow } from '#/components/today/day-strip'
import type { DayStripMeeting } from '#/components/today/day-strip'
import { FirstRun } from '#/components/today/first-run'
import { MeetingsSection, useDayMeetings } from '#/components/today/meetings'
import { NeedsYou } from '#/components/today/needs-you'
import type { NeedsYouRow } from '#/components/today/needs-you'
import { NoticesBand } from '#/components/today/notices'
import { PortfolioRail, WhatsMoving } from '#/components/today/rail'
import { todayReadouts } from '#/components/today/readouts'
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
  dueFigure,
  IDLE_DEAL_DAYS,
  medianOf,
  STALE_MARK_DAYS,
  todayFoldStamp,
  todayStamp,
} from '#/lib/today/needs-you'
import type { NeedsFilter, ReadoutFilter } from '#/lib/today/needs-you'
import { stripLabel, whoLine } from '#/lib/meetings/day'
import { useSettled } from '#/lib/today/use-settled'
import { dayKey, formatAge, formatTime } from '@spaces/core/format'
import { fmtMoney } from '@spaces/core/portfolio/format'
import { useClock } from '#/components/clock'
import { modalSearch, openModalId } from '#/lib/modal-search'
import { GLOBAL_ACTIONS, runBinding, usePageActions } from '#/lib/page-actions'
import { AddMarkDialog } from '#/routes/_app/portfolio_.$holdingId'

const DAY_MS = 86_400_000

/**
 * Today: the one surface that gathers what needs the reader — tasks, idle
 * deals, stale marks, meetings nobody wrote up and Review — in one ranked
 * ledger, with what stops the machine above it, the day's meetings under
 * it and the portfolio and what's moving beside it.
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
  // Deferred: Review, the notices and What's moving arrive after the page.
  const attention = getTodayAttention()
  const [
    tasks,
    holdings,
    funnel,
    activity,
    dealRegistry,
    unfiledCount,
    stoppedPlugins,
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

type Loaded = Awaited<ReturnType<typeof loadToday>>

/**
 * The figure lane of something that happened: the time when it was today,
 * else its age (`2d`).
 */
function sinceFigure(at: string, now: Date): string {
  return dayKey(at) === dayKey(now) ? formatTime(at) : formatAge(at, now)
}

/** The head: the date line and the plain title, with no verbs. */
function TodayHead({ today }: { today: string }) {
  return (
    <PageHeader
      eyebrow={
        <span className="tracking-normal normal-case">{todayStamp(today)}</span>
      }
      title="Today"
      foldMeta={todayFoldStamp(today)}
    />
  )
}

function TodayPage() {
  const data = Route.useLoaderData()
  const { today } = useClock()
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
  const me = useRouteContext({ from: '/_app' }).session.user
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
    meetings,
  } = data
  const attention = useSettled(data.attention)
  // The composer row reports what it made; the wash is for arrivals only.
  const { washes, bear } = useBornRows()
  const taskMenu = useTaskMenu({ me, today })

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
  // A mark row opens Record a mark on its holding, over Today.
  const [markFor, setMarkFor] = useState<string | null>(null)

  // Needs you's filter lives here, so a readout can set it; `pinned` is the
  // readout whose segment rides after `All` until it is cleared.
  const [filter, setFilter] = useState<NeedsFilter>('all')
  const [pinned, setPinned] = useState<ReadoutFilter | null>(null)
  const chooseFilter = (next: NeedsFilter) => {
    setFilter(next)
    if (next !== pinned) setPinned(null)
  }
  const pressReadout = (id: ReadoutFilter) => {
    if (filter === id) {
      setFilter('all')
      setPinned(null)
    } else {
      setFilter(id)
      setPinned(id)
    }
  }

  // The section's day moves with ‹ ›, and the strip follows it.
  const [day, setDay] = useState(today)
  const [version, setVersion] = useState(0)
  const shown = useDayMeetings(meetings.calendar ? day : null, version)
  // The meeting whose Prep runs in its window, for its row's action lane.
  const [preparing, setPreparing] = useState<string | null>(null)
  const onPrepRunning = useCallback(
    (running: boolean) => setPreparing(running ? meetingId : null),
    [meetingId],
  )
  // A meeting's day is the reader's, so its figure waits for the browser clock.
  const now = useNow()

  const dueTasks = tasks.open.filter((t) => t.dueDate && t.dueDate <= today)
  const overdue = dueTasks.filter((t) => t.dueDate && t.dueDate < today).length

  // Live holdings: priced, not written off, with money in.
  const live = holdings.holdings.flatMap((h) => {
    if (!h.metrics.ok) return []
    const m = h.metrics.metrics
    if (m.writtenOff || m.costBasis === 0) return []
    return [
      {
        id: h.id,
        company: h.companyName,
        sensitive: h.sensitive,
        lastMark: m.lastMarkDate,
        value: fmtMoney(m.unrealized, m.currency, { compact: true }),
      },
    ]
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
  const stageLabel = (id: string) =>
    stageOptions.find((o) => o.id === id)?.label ?? id
  const medians = funnel.medianDaysInStage
  // One set for the readout and the rows, so the two counts agree.
  const pastMedian = dealsPastMedian(funnel.daysInStage, medians, activeStages)

  const review = attention.state === 'done' ? attention.value.review : []
  const rows = byUrgency<NeedsYouRow>([
    ...dueTasks.map((t): NeedsYouRow => ({
      kind: 'task',
      key: `task:${t.id}`,
      weight: t.dueDate ? daysBetween(t.dueDate, today) : 0,
      sensitive: t.entities.find((e) => e.sensitive)?.name ?? null,
      task: t,
      record: t.entities.at(0)?.name ?? null,
      who: t.assigneeId === me.id ? null : t.assigneeName,
      due: t.dueDate ? dueFigure(t.dueDate, today) : '',
      late: !!t.dueDate && t.dueDate < today,
    })),
    ...pastMedian.map((d): NeedsYouRow => ({
      kind: 'deal',
      key: `deal:${d.id}`,
      weight: daysPastMedian(d, medians) ?? (d.days ?? 0) - IDLE_DEAL_DAYS,
      sensitive: d.sensitive ? d.name : null,
      id: d.id,
      name: d.name,
      stage: stageLabel(d.stage),
      days: Math.round(d.days ?? 0),
      median: medianOf(d.stage, medians),
      who: d.owner,
    })),
    ...stale.map((h): NeedsYouRow => {
      const age = h.lastMark === null ? null : daysBetween(h.lastMark, today)
      return {
        kind: 'mark',
        key: `mark:${h.id}`,
        // Never marked is the stalest a holding can be.
        weight: age ?? Number.MAX_SAFE_INTEGER,
        sensitive: h.sensitive ? h.company : null,
        holdingId: h.id,
        company: h.company,
        value: h.value,
        age,
      }
    }),
    ...review.map((g): NeedsYouRow => ({
      kind: 'review',
      key: `review:${g.key}`,
      weight: g.total,
      sensitive: null,
      group: g,
      figure: now === null ? null : sinceFigure(g.oldestAt, now),
    })),
    ...meetings.unwritten.map((m): NeedsYouRow => ({
      kind: 'meeting',
      key: `meeting:${m.id}`,
      // Oldest first, from the instant alone: the same order on server and client.
      weight: -Date.parse(m.startsAt),
      sensitive: m.sensitive,
      id: m.id,
      title: m.title ?? 'Meeting',
      record: m.record,
      who: m.who,
      figure: now === null ? null : sinceFigure(m.startsAt, now),
    })),
  ])

  const readouts = todayReadouts({
    overdue,
    pastMedian: pastMedian.length,
    oldestMarkAge: oldestAge,
    unfiled: unfiledCount,
  })
  const pinnedFilter =
    readouts.find((r) => r.filter !== undefined && r.filter.id === pinned)
      ?.filter ?? null

  async function complete(id: string) {
    try {
      await setTaskDone({ data: { id, done: true } })
      void router.invalidate()
    } catch {
      toast.error('Could not update the task')
    }
  }

  const stripDay = (shown === null || shown === 'failed' ? [] : shown)
    .filter((m) => !m.cancelled)
    .map((m): DayStripMeeting => ({
      id: m.id,
      label: stripLabel(m),
      title: m.title ?? 'Meeting',
      who: whoLine(m.external),
      startsAt: m.startsAt,
      endsAt: m.endsAt,
    }))

  return (
    <div className="flex min-h-full flex-col">
      <TodayHead today={today} />
      {/* No visible trigger: `L` and Cmd-K open it. */}
      <LogInteractionDialog hotkey="l" trigger={null} />
      {meetings.calendar ? (
        <DayStrip
          day={day}
          today={today}
          meetings={stripDay}
          onOpen={(id) => openMeeting(id)}
        />
      ) : null}
      {readouts.length > 0 ? (
        <div className="border-b border-hairline px-8">
          <ReadoutStrip
            className="border-t-0"
            fixed
            readouts={readouts.map((r) => {
              const by = r.filter
              return by === undefined
                ? r.cell
                : {
                    ...r.cell,
                    press: {
                      pressed: filter === by.id,
                      onPress: () => pressReadout(by.id),
                    },
                  }
            })}
          />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-6 px-8 pt-6 pb-10">
          <NoticesBand
            stopped={stoppedPlugins}
            broken={attention.state === 'done' ? attention.value.broken : []}
            parked={attention.state === 'done' ? attention.value.parked : []}
            waiting={attention.state === 'done' ? attention.value.waiting : []}
            failing={attention.state === 'done' ? attention.value.failing : []}
          />
          <NeedsYou
            rows={rows}
            filter={filter}
            onFilter={chooseFilter}
            readout={
              pinnedFilter === null
                ? null
                : { id: pinnedFilter.id, label: pinnedFilter.segment }
            }
            loading={attention.state === 'pending'}
            onComplete={(id) => void complete(id)}
            onOpen={(row) => {
              if (row.kind === 'meeting') openMeeting(row.id)
              else if (row.kind === 'mark') setMarkFor(row.holdingId)
            }}
            taskMenu={taskMenu.menuFor}
            onCreated={bear}
            washes={washes}
          />
          <MeetingsSection
            calendar={meetings.calendar}
            audience={meetings.audience}
            today={today}
            day={day}
            onDay={setDay}
            meetings={shown}
            preparing={preparing}
            onOpen={openMeeting}
            onRetry={() => setVersion((v) => v + 1)}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-6 border-t border-hairline bg-bone p-5 xl:w-90 xl:border-t-0 xl:border-l">
          {holdings.holdings.length > 0 ? (
            <PortfolioRail
              rollup={holdings.rollup}
              baseCurrency={holdings.baseCurrency}
            />
          ) : null}
          <WhatsMoving
            signals={
              attention.state === 'done'
                ? attention.value.moving
                : attention.state === 'failed'
                  ? 'failed'
                  : 'loading'
            }
            team={team}
            today={today}
            onRetry={() => void router.invalidate()}
          />
        </aside>
      </div>
      {taskMenu.windows}
      {markFor === null ? null : (
        <AddMarkDialog
          key={markFor}
          holdingId={markFor}
          opened={{
            open: true,
            onOpenChange: (open) => {
              if (!open) setMarkFor(null)
            },
          }}
        />
      )}
      <MeetingDialog
        id={meetingId}
        prepOnOpen={prepFor !== null && prepFor === meetingId}
        onPrepRunning={onPrepRunning}
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
