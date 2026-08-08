import { createFileRoute, Link } from '@tanstack/react-router'
import { Sunrise } from 'lucide-react'
import { GettingStarted } from '#/components/getting-started'
import { TaskComposer } from '#/components/task-composer'
import {
  dealFunnelStats,
  getOnboardingProgress,
  getWorkspaceActivity,
  listHoldings,
  listRegistry,
  listTasks,
} from '#/lib/server-fns'
import { fmtDate, fmtMoney, fmtMultiple } from '#/lib/portfolio/format'
import { localToday } from '#/lib/tasks/parse-due'

/**
 * The Today page (CONTEXT.md 15b): attention-driven, not chart-driven.
 * Self-hosted has no notification emails — opening the app IS the
 * notification, and this page is what opens. Every section is "what needs
 * me", none is "how are we doing" (a solo GP knows that by heart).
 */
export const Route = createFileRoute('/_app/today')({
  loader: async () => {
    const [tasks, holdings, funnel, progress, activity, dealRegistry] =
      await Promise.all([
        listTasks(),
        listHoldings(),
        dealFunnelStats(),
        getOnboardingProgress(),
        getWorkspaceActivity(),
        listRegistry({ data: { kind: 'deal' } }),
      ])
    return { tasks, holdings, funnel, progress, activity, dealRegistry }
  },
  component: TodayPage,
})

const STALE_MARK_DAYS = 180
const IDLE_DEAL_DAYS = 21

function TodayPage() {
  const { tasks, holdings, funnel, progress, activity, dealRegistry } =
    Route.useLoaderData()
  const today = localToday()

  const dueTasks = tasks.open.filter((t) => t.dueDate && t.dueDate <= today)

  const staleCutoff = new Date(Date.now() - STALE_MARK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const staleHoldings = holdings.holdings.filter((h) => {
    if (!h.metrics.ok) return false
    const m = h.metrics.metrics
    if (m.writtenOff || m.costBasis === 0) return false
    return m.lastMarkDate === null || m.lastMarkDate < staleCutoff
  })

  const stageDef = dealRegistry.find((d) => d.slug === 'stage')
  const stageOptions =
    (
      stageDef?.options as
        | { options?: Array<{ id: string; label: string; group?: string }> }
        | undefined
    )?.options ?? []
  const activeStages = new Set(
    stageOptions
      .filter((o) => (o.group ?? 'active') === 'active')
      .map((o) => o.id),
  )
  const stageLabel = (id: string) =>
    stageOptions.find((o) => o.id === id)?.label ?? id
  const idleDeals = funnel.daysInStage
    .filter(
      (d) =>
        activeStages.has(d.stage) && d.days !== null && d.days > IDLE_DEAL_DAYS,
    )
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0))

  const missingRates = holdings.rollup.excludedForMissingRates.length
  const nothingNeedsYou =
    dueTasks.length === 0 &&
    staleHoldings.length === 0 &&
    idleDeals.length === 0 &&
    missingRates === 0

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 md:px-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-page font-semibold tracking-tight">Today</h1>
          <p className="mt-1 text-ui text-muted-foreground">
            What needs your attention — nothing here means go read something.
          </p>
        </div>
        <TaskComposer />
      </header>

      <GettingStarted progress={progress} />

      {holdings.holdings.length > 0 ? (
        <div className="mt-6 flex flex-wrap items-baseline gap-x-8 gap-y-2 rounded-lg border border-border px-4 py-3">
          <Stat
            label="Invested"
            value={fmtMoney(holdings.rollup.costBasis, holdings.baseCurrency, {
              compact: true,
            })}
          />
          <Stat
            label="Value"
            value={fmtMoney(
              holdings.rollup.unrealized + holdings.rollup.realized,
              holdings.baseCurrency,
              { compact: true },
            )}
          />
          <Stat label="MOIC" value={fmtMultiple(holdings.rollup.moic)} />
          <Link
            to="/portfolio"
            className="focus-ring ml-auto rounded text-label text-muted-foreground hover:text-foreground"
          >
            Portfolio →
          </Link>
        </div>
      ) : null}

      {nothingNeedsYou ? (
        <div className="mt-10 flex flex-col items-center py-10 text-center">
          <Sunrise className="size-8 text-muted-foreground" strokeWidth={1.5} />
          <p className="mt-3 text-ui text-muted-foreground">
            Nothing overdue, nothing stale, nothing idle. The map could always
            be deeper — go file a memo.
          </p>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {dueTasks.length > 0 ? (
            <Attention title={`Due — ${dueTasks.length}`}>
              {dueTasks.map((t) => (
                <li key={t.id} className="flex items-baseline gap-3 px-4 py-2">
                  <span className="min-w-0 flex-1 truncate text-ui">
                    {t.content}
                  </span>
                  {t.entities[0] ? (
                    <span className="text-label text-muted-foreground">
                      {t.entities[0].name}
                    </span>
                  ) : null}
                  <span
                    className={
                      t.dueDate && t.dueDate < today
                        ? 'tabular text-label text-destructive'
                        : 'tabular text-label text-muted-foreground'
                    }
                  >
                    {fmtDate(t.dueDate)}
                  </span>
                </li>
              ))}
              <li className="px-4 py-2">
                <Link
                  to="/tasks"
                  className="focus-ring rounded text-label text-muted-foreground hover:text-foreground"
                >
                  All tasks →
                </Link>
              </li>
            </Attention>
          ) : null}

          {idleDeals.length > 0 ? (
            <Attention title={`Idle deals — ${idleDeals.length}`}>
              {idleDeals.map((d) => (
                <li key={d.id}>
                  <Link
                    to="/deals/$dealId"
                    params={{ dealId: d.id }}
                    className="focus-ring flex items-baseline gap-3 px-4 py-2 hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate text-ui">
                      {d.name}
                    </span>
                    <span className="text-label text-muted-foreground">
                      {stageLabel(d.stage)}
                    </span>
                    <span className="tabular text-label text-destructive">
                      {Math.round(d.days ?? 0)}d in stage
                    </span>
                  </Link>
                </li>
              ))}
            </Attention>
          ) : null}

          {staleHoldings.length > 0 ? (
            <Attention title={`Stale marks — ${staleHoldings.length}`}>
              {staleHoldings.map((h) => (
                <li key={h.id}>
                  <Link
                    to="/portfolio/$holdingId"
                    params={{ holdingId: h.id }}
                    className="focus-ring flex items-baseline gap-3 px-4 py-2 hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate text-ui">
                      {h.companyName}
                    </span>
                    <span className="text-label text-muted-foreground">
                      {h.metrics.ok && h.metrics.metrics.lastMarkDate
                        ? `marked ${fmtDate(h.metrics.metrics.lastMarkDate)}`
                        : 'never marked'}
                    </span>
                  </Link>
                </li>
              ))}
            </Attention>
          ) : null}

          {missingRates > 0 ? (
            <Attention title="FX rates missing">
              <li className="px-4 py-2">
                <Link
                  to="/settings"
                  className="focus-ring rounded text-ui text-destructive hover:opacity-80"
                >
                  {missingRates} holding{missingRates === 1 ? '' : 's'} excluded
                  from portfolio totals — add rates in Settings →
                </Link>
              </li>
            </Attention>
          ) : null}
        </div>
      )}

      {activity.length > 0 ? (
        <section className="mt-10">
          <h2 className="mb-2 text-label font-semibold tracking-wide text-muted-foreground uppercase">
            Recent activity
          </h2>
          <ol className="space-y-1">
            {activity.map((a) => (
              <li key={a.id} className="flex items-baseline gap-2 text-ui">
                <span className="font-medium">{a.actorName}</span>
                <span className="text-muted-foreground">
                  {a.verb.replace(/[._]/g, ' ')}
                </span>
                {a.subjectName ? (
                  <span className="truncate">{a.subjectName}</span>
                ) : null}
                <span className="tabular ml-auto shrink-0 text-label text-muted-foreground">
                  {fmtDate(a.at.slice(0, 10))}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-label text-muted-foreground">{label}</span>
      <span className="tabular text-ui font-medium">{value}</span>
    </span>
  )
}

function Attention({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="mb-2 text-label font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <ol className="divide-y divide-border rounded-lg border border-border">
        {children}
      </ol>
    </section>
  )
}
