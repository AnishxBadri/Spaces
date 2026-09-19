import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Sunrise } from 'lucide-react'
import { toast } from 'sonner'
import { GettingStarted } from '#/components/getting-started'
import {
  LedgerFigure,
  LedgerRow,
  LedgerSection,
  ReferenceBar,
} from '#/components/ledger-section'
import { KeyHint, PageHeader, ReadoutStrip } from '#/components/page-header'
import { TaskComposer } from '#/components/task-composer'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import {
  dealFunnelStats,
  getOnboardingProgress,
  getWorkspaceActivity,
  listDuplicates,
  listHoldings,
  listRegistry,
  listTasks,
  setTaskDone,
} from '#/lib/server-fns'
import { fmtMoney, fmtMultiple } from '@spaces/core/portfolio/format'
import { localToday } from '@spaces/core/tasks/parse-due'

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

/** Whole days between two ISO dates, b − a. */
function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() -
      new Date(`${a}T00:00:00Z`).getTime()) /
      86_400_000,
  )
}

/** The when-lane of a due row: −2d, today, or the ISO date. */
function dueFigure(due: string, today: string): string {
  const d = daysBetween(today, due)
  if (d === 0) return 'today'
  if (d < 0) return `−${-d}d`
  return due
}

/** The ledger's time lane, date-only so server and client agree. */
function whenLabel(atIso: string, today: string): string {
  const day = atIso.slice(0, 10)
  const d = daysBetween(day, today)
  if (d === 0) return 'today'
  if (d === 1) return 'yest'
  return day.slice(5)
}

/** Two-letter type code for a ledger entry, from the verb's subject. */
function verbCode(verb: string): string {
  const [subject, action] = verb.split('.')
  const CODES: Record<string, string> = {
    mark: 'MK',
    investment: 'IN',
    round: 'RD',
    holding: 'HL',
    deal: 'DL',
    company: 'CO',
    person: 'PE',
    note: 'NT',
    document: 'FI',
    space: 'SP',
    term: 'TM',
    mandate: 'MD',
    task: 'TK',
    interaction: 'IX',
  }
  return CODES[subject] ?? (action ? subject : verb).slice(0, 2).toUpperCase()
}

function TodayPage() {
  const router = useRouter()
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
  const stageOptions = stageDef?.options.options ?? []
  const activeStages = new Set(
    stageOptions
      .filter((o) => (o.group ?? 'active') === 'active')
      .map((o) => o.id),
  )
  const stageLabel = (id: string) =>
    stageOptions.find((o) => o.id === id)?.label ?? id
  // The stage pill reads the same option row the board reads, so optionColor's
  // index fallback lands both surfaces on the same hue.
  const stageBadge = (id: string) => {
    const idx = stageOptions.findIndex((o) => o.id === id)
    return {
      option: idx >= 0 ? stageOptions[idx] : undefined,
      index: Math.max(idx, 0),
      // A retired stage reads as history here too: no hue, muted ink.
      archived: idx >= 0 && Boolean(stageOptions[idx].archived),
    }
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

  async function complete(id: string) {
    try {
      await setTaskDone({ data: { id, done: true } })
      void router.invalidate()
    } catch {
      toast.error('Could not update the task')
    }
  }

  const idleScale = Math.max(1, ...idleDeals.map((d) => d.days ?? 0))
  const median = (stage: string): number | null =>
    funnel.medianDaysInStage[stage] ?? null

  const ledger = activity.slice(0, 8)
  const totalValue = holdings.rollup.unrealized + holdings.rollup.realized

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
            to: '/settings/currency',
          },
          { label: 'Dedupe inbox', value: dedupeCount, to: '/dedupe' },
        ]}
      />

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        {/* The spine: what needs you, as ledgers. */}
        <div className="flex min-w-0 flex-1 flex-col gap-10 px-8 pt-6 pb-10">
          <GettingStarted progress={progress} />

          {nothingNeedsYou ? (
            <div className="flex flex-col items-center py-10 text-center">
              <Sunrise className="size-8 text-graphite" strokeWidth={1.5} />
              <p className="mt-3 text-ui text-graphite">
                Nothing overdue, nothing stale, nothing idle. The map could
                always be deeper — go file a memo.
              </p>
            </div>
          ) : null}

          {dueTasks.length > 0 ? (
            <LedgerSection
              label="Due"
              count={
                overdue > 0
                  ? `${dueTasks.length} · ${overdue} overdue`
                  : `${dueTasks.length}`
              }
              link={
                <Link to="/tasks" className="focus-ring hover:text-foreground">
                  all tasks ›
                </Link>
              }
            >
              {dueTasks.map((t) => {
                const late = !!t.dueDate && t.dueDate < today
                return (
                  <LedgerRow key={t.id}>
                    <Checkbox
                      checked={false}
                      onCheckedChange={() => void complete(t.id)}
                      aria-label="Complete task"
                    />
                    <span className="min-w-0 truncate text-ui">
                      {t.content}
                    </span>
                    {t.entities[0] ? (
                      <span className="shrink-0 truncate mono text-micro text-graphite">
                        {t.entities[0].name}
                      </span>
                    ) : null}
                    <span className="flex-1" />
                    <span className="shrink-0 mono text-micro text-graphite">
                      {t.assigneeName}
                    </span>
                    <LedgerFigure tone={late ? 'bad' : undefined}>
                      {t.dueDate ? dueFigure(t.dueDate, today) : '—'}
                    </LedgerFigure>
                  </LedgerRow>
                )
              })}
              <LedgerRow last>
                <TaskComposer
                  trigger={
                    <button
                      type="button"
                      className="focus-ring-inset flex h-full w-full items-center gap-3 text-left"
                    >
                      <span className="mono text-micro text-primary">+</span>
                      <span className="min-w-0 truncate text-ui text-graphite">
                        Add a task… natural dates work: “fri”, “in 2w”, “next
                        month”
                      </span>
                      <span className="flex-1" />
                      <KeyHint>T</KeyHint>
                    </button>
                  }
                />
              </LedgerRow>
            </LedgerSection>
          ) : null}

          {idleDeals.length > 0 ? (
            <LedgerSection
              label="Idle in stage"
              count={`${idleDeals.length} · over ${IDLE_DEAL_DAYS}d, from the stage log`}
              link={
                <Link to="/deals" className="focus-ring hover:text-foreground">
                  board ›
                </Link>
              }
            >
              {idleDeals.map((d, i) => {
                const days = Math.round(d.days ?? 0)
                const med = median(d.stage)
                const past = med !== null && med > 0 && days > 2 * med
                return (
                  <LedgerRow key={d.id} last={i === idleDeals.length - 1}>
                    <Link
                      to="/deals/$dealId"
                      params={{ dealId: d.id }}
                      className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 hover:bg-bone"
                    >
                      <span className="w-65 shrink-0 truncate text-ui font-medium">
                        {d.name}
                      </span>
                      <span className="flex w-[6.875rem] shrink-0">
                        <Badge
                          {...stageBadge(d.stage)}
                          className="h-[1.125rem]"
                        >
                          {stageLabel(d.stage)}
                        </Badge>
                      </span>
                      <ReferenceBar
                        value={days}
                        median={med}
                        scale={idleScale}
                      />
                      <span className="mono text-micro text-graphite">
                        {med === null ? 'no median' : `med ${med}d`}
                      </span>
                      <span className="flex-1" />
                      <LedgerFigure tone={past ? 'bad' : undefined}>
                        {days}d
                      </LedgerFigure>
                    </Link>
                  </LedgerRow>
                )
              })}
            </LedgerSection>
          ) : null}

          {staleHoldings.length > 0 ? (
            <LedgerSection
              label="Stale marks"
              count={`${staleHoldings.length} · no mark in ${STALE_MARK_DAYS}d`}
              link={
                <Link
                  to="/portfolio"
                  className="focus-ring hover:text-foreground"
                >
                  portfolio ›
                </Link>
              }
            >
              {staleHoldings.map((h, i) => {
                const m = h.metrics.ok ? h.metrics.metrics : null
                const last = m?.lastMarkDate ?? null
                return (
                  <LedgerRow key={h.id} last={i === staleHoldings.length - 1}>
                    <Link
                      to="/portfolio/$holdingId"
                      params={{ holdingId: h.id }}
                      className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 hover:bg-bone"
                    >
                      <span className="w-65 shrink-0 truncate text-ui font-medium">
                        {h.companyName}
                      </span>
                      <span className="min-w-0 truncate mono text-micro text-graphite">
                        {last && m
                          ? `last mark ${last} · ${fmtMoney(m.unrealized, m.currency, { compact: true })}`
                          : 'never marked'}
                      </span>
                      <span className="flex-1" />
                      <span className="mono text-micro text-primary">
                        record mark ›
                      </span>
                      <LedgerFigure tone="bad">
                        {last ? `${daysBetween(last, today)}d` : '—'}
                      </LedgerFigure>
                    </Link>
                  </LedgerRow>
                )
              })}
            </LedgerSection>
          ) : null}
        </div>

        {/* The rail: bone, what the instrument reads at rest. */}
        <aside className="flex w-full shrink-0 flex-col border-t border-hairline bg-bone xl:w-100 xl:border-t-0 xl:border-l">
          {holdings.holdings.length > 0 ? (
            <section className="flex flex-col border-b border-hairline px-6 py-5">
              <div className="flex items-baseline justify-between pb-2.5">
                <h2 className="label-caps text-graphite">Portfolio</h2>
                <span className="mono text-micro text-graphite">
                  {holdings.baseCurrency} · {holdings.holdings.length} holding
                  {holdings.holdings.length === 1 ? '' : 's'}
                </span>
              </div>
              <RailReadout
                label="Invested"
                value={fmtMoney(
                  holdings.rollup.costBasis,
                  holdings.baseCurrency,
                )}
              />
              <RailReadout
                label="Value"
                value={fmtMoney(totalValue, holdings.baseCurrency)}
              />
              <RailReadout
                label="MOIC"
                value={fmtMultiple(holdings.rollup.moic)}
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

          {activity.length > 0 ? (
            <section className="flex flex-col px-6 py-5">
              <div className="flex items-baseline justify-between pb-2.5">
                <h2 className="label-caps text-graphite">Ledger</h2>
                <span className="mono text-micro text-graphite">
                  {activity.length} entries
                </span>
              </div>
              <ol>
                {ledger.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start gap-3 border-t border-rule py-2"
                  >
                    <span className="w-11 shrink-0 mono text-micro text-graphite">
                      {whenLabel(a.at, today)}
                    </span>
                    <span className="w-5 shrink-0 mono text-field font-medium">
                      {verbCode(a.verb)}
                    </span>
                    <span className="min-w-0 text-label leading-4.25">
                      <span className="font-medium">{a.actorName}</span>{' '}
                      {a.verb.replace(/[._]/g, ' ')}
                      {a.subjectName ? ` · ${a.subjectName}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
              {activity.length > ledger.length ? (
                <div className="flex items-center justify-between border-t border-rule pt-2.5">
                  <span className="mono text-micro text-graphite">
                    + {activity.length - ledger.length} more
                  </span>
                </div>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

function RailReadout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-row items-center justify-between border-t border-rule">
      <span className="field-label text-graphite">{label}</span>
      <span className="mono text-ui font-medium">{value}</span>
    </div>
  )
}
