import { createFileRoute, Link } from '@tanstack/react-router'
import { Sunrise, TriangleAlert } from 'lucide-react'
import { badgeStyle, optionColor } from '#/lib/attributes/colors'
import { GettingStarted } from '#/components/getting-started'
import { KeyHint, PageHeader, ReadoutStrip } from '#/components/page-header'
import { TaskComposer } from '#/components/task-composer'
import { Button } from '#/components/ui/button'
import {
  dealFunnelStats,
  getOnboardingProgress,
  getWorkspaceActivity,
  listDuplicates,
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
    const [
      tasks,
      holdings,
      funnel,
      progress,
      activity,
      dealRegistry,
      duplicates,
    ] = await Promise.all([
      listTasks(),
      listHoldings(),
      dealFunnelStats(),
      getOnboardingProgress(),
      getWorkspaceActivity(),
      listRegistry({ data: { kind: 'deal' } }),
      listDuplicates(),
    ])
    return {
      tasks,
      holdings,
      funnel,
      progress,
      activity,
      dealRegistry,
      dedupeCount: duplicates.length,
    }
  },
  component: TodayPage,
})

const STALE_MARK_DAYS = 180
const IDLE_DEAL_DAYS = 21

const WEEKDAY = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

/** ISO-8601 week number for an ISO date — the instrument's calendar readout. */
function isoWeek(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
}

const WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
]

/** Counts in the serif sentence are prose, so small ones are words; past
 *  twelve the digits go mono (the Numeral Rule). */
function countWord(n: number): React.ReactNode {
  const w = WORDS[n]
  if (w) return w.charAt(0).toUpperCase() + w.slice(1)
  return <span className="mono">{n}</span>
}

function TodayPage() {
  const {
    tasks,
    holdings,
    funnel,
    progress,
    activity,
    dealRegistry,
    dedupeCount,
  } = Route.useLoaderData()
  const today = localToday()

  const dueTasks = tasks.open.filter((t) => t.dueDate && t.dueDate <= today)
  const overdue = dueTasks.filter((t) => t.dueDate && t.dueDate < today).length
  const dueToday = dueTasks.length - overdue

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
        | {
            options?: Array<{
              id: string
              label: string
              group?: string
              color?: string
              archived?: boolean
            }>
          }
        | undefined
    )?.options ?? []
  const activeStages = new Set(
    stageOptions
      .filter((o) => (o.group ?? 'active') === 'active')
      .map((o) => o.id),
  )
  const stageLabel = (id: string) =>
    stageOptions.find((o) => o.id === id)?.label ?? id
  // Badge styling for the stage pill — same data-driven colors the board uses.
  const stageBadge = (id: string) => {
    const idx = stageOptions.findIndex((o) => o.id === id)
    // A retired stage reads as history here too: no hue, muted ink.
    if (idx >= 0 && stageOptions[idx].archived)
      return {
        backgroundColor: 'var(--muted)',
        color: 'var(--muted-foreground)',
      }
    return badgeStyle(
      optionColor(idx >= 0 ? stageOptions[idx] : undefined, Math.max(idx, 0)),
    )
  }
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

  const needsYou =
    dueTasks.length +
    idleDeals.length +
    staleHoldings.length +
    missingRates +
    dedupeCount

  const weekday = WEEKDAY[new Date(`${today}T00:00:00Z`).getUTCDay()]

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        eyebrow={`Today · ${weekday} · ${today} · W${isoWeek(today)}`}
        title={
          needsYou === 0 ? (
            'Nothing needs you.'
          ) : (
            <>
              {countWord(needsYou)}{' '}
              {needsYou === 1 ? 'thing needs' : 'things need'} you.
              {overdue > 0 ? (
                <>
                  {' '}
                  {countWord(overdue)} {overdue === 1 ? 'is' : 'are'} late.
                </>
              ) : null}
            </>
          )
        }
        action={
          <TaskComposer
            hotkey="t"
            trigger={
              <Button variant="outline">
                New task
                <KeyHint>T</KeyHint>
              </Button>
            }
          />
        }
      />
      <ReadoutStrip
        cells={[
          { label: 'Overdue', value: overdue, tone: 'bad', to: '/tasks' },
          { label: 'Due today', value: dueToday, to: '/tasks' },
          {
            label: `Idle deals · >${IDLE_DEAL_DAYS}d`,
            value: idleDeals.length,
            to: '/deals',
          },
          {
            label: `Stale marks · >${STALE_MARK_DAYS}d`,
            value: staleHoldings.length,
            to: '/portfolio',
          },
          {
            label: 'Missing FX',
            value: missingRates,
            tone: 'warn',
            to: '/settings',
          },
          { label: 'Dedupe inbox', value: dedupeCount, to: '/dedupe' },
        ]}
      />

      <div className="mx-auto w-full max-w-column px-8 py-6">
        <GettingStarted progress={progress} />

        {holdings.holdings.length > 0 ? (
          <div className="mt-6 flex flex-wrap items-center gap-x-10 gap-y-2 rounded-lg border border-border px-4 py-3">
            <Stat
              label="Invested"
              value={fmtMoney(
                holdings.rollup.costBasis,
                holdings.baseCurrency,
                {
                  compact: true,
                },
              )}
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
            <Sunrise
              className="size-8 text-muted-foreground"
              strokeWidth={1.5}
            />
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
                  <li key={t.id} className="flex h-10 items-center gap-3 px-4">
                    <span className="min-w-0 truncate text-ui">
                      {t.content}
                    </span>
                    {t.entities[0] ? (
                      <span className="shrink-0 truncate text-label text-muted-foreground">
                        {t.entities[0].name}
                      </span>
                    ) : null}
                    <span
                      className={
                        t.dueDate && t.dueDate < today
                          ? 'tabular ml-auto shrink-0 text-label text-destructive'
                          : 'tabular ml-auto shrink-0 text-label text-muted-foreground'
                      }
                    >
                      {fmtDate(t.dueDate)}
                    </span>
                  </li>
                ))}
                {/* Footer row on the second neutral — a quiet exit, not a row. */}
                <li className="flex h-8 items-center bg-sidebar px-4">
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
                      className="focus-ring flex h-10 items-center gap-3 px-4 hover:bg-accent"
                    >
                      <span className="min-w-0 truncate text-ui font-medium">
                        {d.name}
                      </span>
                      <span
                        className="shrink-0 rounded px-2 py-0.5 text-label font-medium"
                        style={stageBadge(d.stage)}
                      >
                        {stageLabel(d.stage)}
                      </span>
                      <span className="tabular ml-auto shrink-0 text-label text-destructive">
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
                      className="focus-ring flex h-10 items-center gap-3 px-4 hover:bg-accent"
                    >
                      <span className="min-w-0 truncate text-ui font-medium">
                        {h.companyName}
                      </span>
                      <span className="ml-auto shrink-0 text-label text-muted-foreground">
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
              // A warning line, not a card — this is a data-quality nag, not a
              // work queue like the sections above it.
              <Link
                to="/settings"
                className="focus-ring flex w-fit items-center gap-1.5 rounded text-label text-destructive hover:opacity-80"
              >
                <TriangleAlert className="size-3" strokeWidth={2} />
                {missingRates} holding{missingRates === 1 ? '' : 's'} excluded
                from portfolio totals — add rates in Settings →
              </Link>
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
                <li key={a.id} className="flex h-7 items-center gap-2 text-ui">
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
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-micro font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className="tabular text-title font-semibold">{value}</span>
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
