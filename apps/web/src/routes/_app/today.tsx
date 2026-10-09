import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { PageHeader, ReadoutStrip } from '#/components/page-header'
import { PortfolioHeadlineRail } from '#/components/portfolio-headline'
import { DayStrip } from '#/components/today/day-strip'
import { FirstRun } from '#/components/today/first-run'
import { NeedsYou } from '#/components/today/needs-you'
import type { NeedsYouRow, StageBadge } from '#/components/today/needs-you'
import { NoticesBand } from '#/components/today/notices'
import { TeamActivity, WhatsMoving } from '#/components/today/rail'
import { useBornRows } from '#/lib/born-rows'
import {
  countCompanies,
  countUnfiledDocuments,
  dealFunnelStats,
  getTodayAttention,
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

const DAY_MS = 86_400_000

/**
 * Today: the one surface that gathers what needs the reader — tasks, idle
 * deals, stale marks and Review — in one ranked ledger, with what stops the
 * machine above it and the portfolio and what's moving beside it. (D79)
 * With no company yet it is the three ways in and nothing else. (D80)
 */
export const Route = createFileRoute('/_app/today')({
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

function TodayPage() {
  const data = Route.useLoaderData()
  const today = localToday()
  if (data.empty)
    return (
      <div className="flex min-h-full flex-col">
        <PageHeader title="Today" description={todayStamp(today)} />
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
  const {
    tasks,
    holdings,
    funnel,
    team,
    dealRegistry,
    unfiledCount,
    stoppedPlugins,
    attention,
  } = data
  // The composer row reports what it made; the wash is for arrivals only.
  const { washes, bear } = useBornRows()

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
  ])

  async function complete(id: string) {
    try {
      await setTaskDone({ data: { id, done: true } })
      void router.invalidate()
    } catch {
      toast.error('Could not update the task')
    }
  }

  const missingRates = holdings.rollup.excludedForMissingRates.length

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title="Today" description={todayStamp(today)} />
      <DayStrip />
      <ReadoutStrip
        cells={[
          { label: 'Overdue', value: overdue, tone: 'bad', to: '/tasks' },
          {
            label: 'Deals past stage median',
            value: pastMedian,
            tone: 'warn',
            to: '/deals',
          },
          {
            label: 'Oldest mark',
            value: oldestAge === null ? '—' : `${oldestAge}d`,
            ...(oldestAge !== null && oldestAge > STALE_MARK_DAYS
              ? { tone: 'bad' as const }
              : {}),
            to: '/portfolio',
          },
          {
            label: 'Unfiled files',
            value: unfiledCount,
            to: '/files',
            search: { filed: 'unfiled' },
          },
        ]}
      />

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-6 px-8 pt-6 pb-10">
          <NoticesBand stopped={stoppedPlugins} broken={attention.broken} />
          <NeedsYou
            rows={rows}
            today={today}
            onComplete={(id) => void complete(id)}
            onCreated={bear}
            washes={washes}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col border-t border-hairline bg-bone xl:w-100 xl:border-t-0 xl:border-l">
          {holdings.holdings.length > 0 ? (
            <section className="flex flex-col border-b border-hairline px-6 py-5">
              <div className="flex items-baseline justify-between pb-2.5">
                <h2 className="text-title font-medium text-foreground">
                  Portfolio
                </h2>
                <span className="mono text-micro text-graphite">
                  {holdings.baseCurrency} · {holdings.holdings.length} holding
                  {holdings.holdings.length === 1 ? '' : 's'}
                </span>
              </div>
              <PortfolioHeadlineRail
                rollup={holdings.rollup}
                baseCurrency={holdings.baseCurrency}
              />
              {missingRates > 0 ? (
                <div className="flex h-row items-center justify-between border-t border-rule">
                  <span className="field-label text-warning">
                    {missingRates} holding{missingRates === 1 ? '' : 's'}{' '}
                    unpriced
                  </span>
                  <Link
                    to="/settings/currency"
                    className="focus-ring mono text-micro text-primary hover:underline"
                  >
                    add FX rate ›
                  </Link>
                </div>
              ) : (
                <div className="flex h-row items-center justify-between border-t border-rule">
                  <span className="field-label text-graphite">All priced</span>
                  <Link
                    to="/portfolio"
                    className="focus-ring mono text-micro text-foreground hover:underline"
                  >
                    portfolio ›
                  </Link>
                </div>
              )}
            </section>
          ) : null}
          <WhatsMoving signals={attention.moving} today={today} />
          <TeamActivity entries={team} today={today} />
        </aside>
      </div>
    </div>
  )
}
