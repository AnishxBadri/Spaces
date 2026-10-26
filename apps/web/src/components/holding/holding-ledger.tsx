import { useRouter } from '@tanstack/react-router'
import { Ban, ChevronDown, Link2 } from 'lucide-react'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { MoreMenu } from '#/components/ui/more-menu'
import type { HoldingFigure } from '#/lib/portfolio/figures'
import { voidLedgerEvent } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * The holding's one view: the figures row with its as-of day at the top of
 * the pane, then one append-only ledger per event kind. There is no edit and
 * no delete: a wrong entry is voided by a compensating event, and the
 * original stays, struck, with its compensating row indented beneath it.
 */

/**
 * The figures, each sized to its value so none is cut, and the outline
 * `As of <day>` control at the right.
 */
export function HoldingFigures({
  figures,
  asOf,
  onAsOf,
  children,
}: {
  figures: ReadonlyArray<HoldingFigure>
  /** The day read at; null is today. */
  asOf: string | null
  /** A day, or null for today. */
  onAsOf: (day: string | null) => void
  /** In place of the figures when there are none to show. */
  children?: ReactNode
}) {
  return (
    <div
      data-figures
      className="flex min-h-16 shrink-0 items-center gap-4 border-b border-rule"
    >
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {figures.length > 0
          ? figures.map((f, i) => (
              <div
                key={f.label}
                data-figure
                className={cn(
                  'flex shrink-0 flex-col justify-center gap-0.5 py-2 pr-6',
                  i > 0 && 'border-l border-rule pl-6',
                )}
              >
                <span className="mono text-page leading-6.5 whitespace-nowrap text-foreground">
                  {f.value}
                </span>
                <span className="text-label whitespace-nowrap text-graphite">
                  {f.label}
                </span>
              </div>
            ))
          : children}
      </div>
      <AsOfControl asOf={asOf} onAsOf={onAsOf} />
    </div>
  )
}

/**
 * `As of 27 Oct ▾`: an outline button over the native date field, whose
 * picker it opens. Choosing today clears the day.
 */
function AsOfControl({
  asOf,
  onAsOf,
}: {
  asOf: string | null
  onAsOf: (day: string | null) => void
}) {
  const { today } = useClock()
  const field = useRef<HTMLInputElement>(null)
  const day = asOf ?? today
  function open() {
    const el = field.current
    if (el === null) return
    // A browser without showPicker focuses the field, whose keys still work.
    if (typeof el.showPicker === 'function') el.showPicker()
    else el.focus()
  }
  return (
    <span className="relative shrink-0">
      <Button
        variant="outline"
        data-as-of={day}
        aria-label={`As of ${formatDay(day, today)}, choose a day`}
        onClick={open}
      >
        As of {formatDay(day, today)}
        <ChevronDown className="size-3.5 text-graphite" />
      </Button>
      <input
        ref={field}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={day}
        max={today}
        onChange={(e) => {
          const next = e.target.value
          onAsOf(next === '' || next >= today ? null : next)
        }}
        className="pointer-events-none absolute inset-0 opacity-0"
      />
    </span>
  )
}

/** The three tables a correction can be appended to. */
export type VoidableTable = 'investment' | 'mark' | 'distribution'

export type EventRow = {
  id: string
  date: string
  /** `SAFE · Northgate Fund II`. */
  label: string
  amount: string
  /** Mono, before the amount: `cap $12M`. */
  detail: string
  /** Non-null on a struck original: when the void was written. */
  reversedAt: string | null
  /** Non-null on the compensating row: the entry it voids. */
  reversesId: string | null
  voidedBy: string | null
  voidedOn: string | null
}

/**
 * One ledger: the section head with its count of live entries, then a row
 * per entry — the day, the entry, its mono detail and the amount, Void in
 * the row's `···`. A voided original is struck and its compensating row
 * sits indented under it. `table` is absent for Rounds, which are not summed
 * events and cannot be voided. With no rows it is `empty`, or nothing.
 */
export function EventSection({
  title,
  rows,
  table,
  empty = null,
}: {
  title: string
  rows: ReadonlyArray<EventRow>
  table?: VoidableTable | undefined
  /** What stands in for the section with no rows: its `Name +` row. */
  empty?: ReactNode
}) {
  const router = useRouter()
  const { today } = useClock()
  const { confirm, confirmDialog } = useConfirm()

  async function onVoid(r: EventRow) {
    if (table === undefined) return
    const ok = await confirm({
      title: `Void this ${title.toLowerCase().replace(/s$/, '')}?`,
      body: 'Nothing is edited and nothing is deleted. A compensating entry is appended, dated as this one is dated, and both stay on the record.',
      rows: [
        {
          name: r.label,
          meta: `${formatDay(r.date.slice(0, 10), today)} · ${r.amount}`,
        },
      ],
      action: 'Void',
    })
    if (!ok) return
    try {
      await voidLedgerEvent({ data: { table, id: r.id } })
      toast('Voided — the correction is on the record')
      void router.invalidate()
    } catch (err) {
      // The server names the refusal ("already voided", "a reversal cannot
      // be reversed"); never a generic toast.
      toast(err instanceof Error ? err.message : 'Could not void this entry')
    }
  }

  if (rows.length === 0) return <>{empty}</>
  const live = rows.filter(
    (r) => r.reversesId === null && r.reversedAt === null,
  )
  return (
    <section aria-label={title} className="flex flex-col">
      <SectionHead title={title} count={String(live.length)} />
      {confirmDialog}
      <ol>
        {rows.map((r) =>
          r.reversesId !== null ? (
            <li
              key={r.id}
              id={`event-${r.id}`}
              data-reversal
              className="flex h-ledger-row items-center gap-3 border-b border-rule px-3 text-graphite"
            >
              <span className="w-24 shrink-0" />
              <span className="min-w-0 flex-1 truncate pl-4 text-ui">
                {[
                  r.voidedBy === null ? 'Voided' : `Voided by ${r.voidedBy}`,
                  r.voidedOn === null ? null : formatDay(r.voidedOn, today),
                ]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </span>
              <span className="shrink-0 mono text-micro">
                compensating entry
              </span>
              <span className="w-32 shrink-0 numeric text-right text-ui">
                {r.amount}
              </span>
              <span className="w-6 shrink-0" />
            </li>
          ) : (
            <li
              key={r.id}
              id={`event-${r.id}`}
              data-row
              className="flex h-ledger-row items-center gap-3 border-b border-rule px-3"
            >
              <span className="w-24 shrink-0 mono text-micro text-graphite">
                {formatDay(r.date.slice(0, 10), today)}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-body',
                  r.reversedAt !== null && 'text-graphite line-through',
                )}
              >
                {r.label}
              </span>
              {r.detail ? (
                <span className="shrink-0 mono text-micro text-graphite">
                  {r.detail}
                </span>
              ) : null}
              <span
                className={cn(
                  'w-32 shrink-0 numeric text-right text-ui',
                  r.reversedAt !== null && 'text-graphite line-through',
                )}
              >
                {r.amount}
              </span>
              <span className="flex w-6 shrink-0 justify-end">
                {table !== undefined && r.reversedAt === null ? (
                  <MoreMenu
                    variant="row"
                    label={r.label}
                    items={[
                      {
                        label: 'Copy link',
                        icon: <Link2 className="size-4" />,
                        copy: () =>
                          `${window.location.origin}${window.location.pathname}#event-${r.id}`,
                      },
                      {
                        label: 'Void…',
                        icon: <Ban className="size-4" />,
                        destructive: true,
                        opens: true,
                        onSelect: () => void onVoid(r),
                      },
                    ]}
                  />
                ) : null}
              </span>
            </li>
          ),
        )}
      </ol>
    </section>
  )
}
