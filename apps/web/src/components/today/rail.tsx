import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { formatWhen } from '@spaces/core/format'
import type { PortfolioRollup } from '@spaces/core/portfolio/rollup'
import { PortfolioHeadlineRail } from '#/components/portfolio-headline'
import { Twinkle } from '#/components/twinkle'
import type { MovingSignal } from '#/lib/server-fns'
import { teamLine } from '#/lib/today/team'
import type { TeamEntry } from '#/lib/today/team'
import { cn } from '#/lib/utils'

/** What's moving shows this many signals before its `n more`. */
const MOVING_SHOWN = 4

/** A citation's printed form: the host, without `www.`. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** A rail section's head: mono caps graphite on a rule, nothing beside it. */
function RailHead({ label }: { label: string }) {
  return (
    <h2 className="border-b border-rule pb-2 label-caps text-graphite">
      {label}
    </h2>
  )
}

/** A 6px square that says a line is a warning (amber) or a failure (rose). */
function Square({ tone }: { tone: 'warn' | 'bad' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0',
        tone === 'warn' ? 'bg-warning' : 'bg-destructive',
      )}
    />
  )
}

/** A rail link: sans, ink, never pine. */
const railLink =
  'focus-ring shrink-0 text-label text-foreground hover:underline'

/**
 * The book in the rail: Invested, Value, MOIC on 32px rows, then — only
 * when a holding has no rate to the base — the line that says so with the
 * way to add the rates. The caller leaves it out with no holdings.
 */
export function PortfolioRail({
  rollup,
  baseCurrency,
}: {
  rollup: PortfolioRollup
  baseCurrency: string
}) {
  const unpriced = rollup.excludedForMissingRates.length
  return (
    <section aria-label="Portfolio" className="flex flex-col">
      <RailHead label="Portfolio" />
      <PortfolioHeadlineRail rollup={rollup} baseCurrency={baseCurrency} />
      {unpriced > 0 ? (
        <div data-missing-rates className="flex h-8 items-center gap-2">
          <Square tone="warn" />
          <span className="min-w-0 flex-1 truncate text-label text-graphite">
            {unpriced} holding{unpriced === 1 ? '' : 's'} out of the totals
          </span>
          <Link to="/settings/currency" className={railLink}>
            Set rates ›
          </Link>
        </div>
      ) : null}
    </section>
  )
}

/** One rail row: the 44px day lane, then the line and its sub-line. */
function RailRow({
  when,
  children,
  sub,
}: {
  when: string
  children: ReactNode
  sub?: ReactNode
}) {
  return (
    <li className="flex items-start gap-2 border-b border-rule py-2 last:border-b-0">
      <span className="w-11 shrink-0 pt-0.5 mono text-micro text-graphite">
        {when}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {children}
        {sub === undefined ? null : (
          <span className="flex min-w-0 items-baseline gap-1 text-label text-graphite">
            {sub}
          </span>
        )}
      </span>
    </li>
  )
}

/** What's moving's read: still coming, failed, or the signals. */
export type MovingState = 'loading' | 'failed' | ReadonlyArray<MovingSignal>

/**
 * What's moving: signals from the last seven days on the reader's
 * companies, newest first, each citing where it was read. Four show; the
 * foot unfolds the rest (`5 more`) and opens the team's last day in place
 * (`Team activity ›`).
 */
export function WhatsMoving({
  signals,
  team,
  today,
  onRetry,
}: {
  signals: MovingState
  team: ReadonlyArray<TeamEntry>
  today: string
  onRetry: () => void
}) {
  const [all, setAll] = useState(false)
  const [teamOpen, setTeamOpen] = useState(false)
  const list = typeof signals === 'string' ? [] : signals
  const shown = all ? list : list.slice(0, MOVING_SHOWN)
  const hidden = list.length - shown.length
  return (
    <section aria-label="What's moving" className="flex flex-col">
      <RailHead label="What's moving" />
      {signals === 'loading' ? (
        <p
          data-moving-loading
          className="flex h-8 items-center gap-2 text-label text-graphite"
        >
          <Twinkle />
          Reading signals
        </p>
      ) : signals === 'failed' ? (
        <p
          data-moving-failed
          className="flex h-8 items-center gap-2 text-label text-graphite"
        >
          <Square tone="bad" />
          <span className="min-w-0 flex-1 truncate">
            Could not load signals
          </span>
          <button type="button" onClick={onRetry} className={railLink}>
            Retry ›
          </button>
        </p>
      ) : list.length === 0 ? (
        <p
          data-moving-empty
          className="flex h-8 items-center text-label text-graphite"
        >
          Nothing new.
        </p>
      ) : (
        <ol>
          {shown.map((s) => {
            const host = s.url === null ? null : hostOf(s.url)
            return (
              <RailRow
                key={s.id}
                when={formatWhen(s.observedAt, today)}
                sub={
                  <>
                    <span className="min-w-0 truncate">
                      {s.companyName} · via {s.source}
                    </span>
                    {s.url !== null && host !== null ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="focus-ring max-w-28 shrink-0 truncate mono hover:text-foreground"
                      >
                        · {host}
                      </a>
                    ) : null}
                  </>
                }
              >
                <Link
                  to="/companies/$companyId"
                  params={{ companyId: s.companyId }}
                  className="focus-ring truncate text-ui text-foreground hover:underline"
                >
                  {s.title ?? s.kind ?? 'Signal'}
                </Link>
              </RailRow>
            )
          })}
        </ol>
      )}
      {hidden > 0 || team.length > 0 ? (
        <div className="flex h-8 items-center justify-between gap-3 border-t border-rule">
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="focus-ring text-label text-graphite hover:text-foreground"
            >
              {hidden} more
            </button>
          ) : (
            <span />
          )}
          {team.length > 0 ? (
            <button
              type="button"
              aria-expanded={teamOpen}
              onClick={() => setTeamOpen((o) => !o)}
              className={railLink}
            >
              Team activity {teamOpen ? '‹' : '›'}
            </button>
          ) : null}
        </div>
      ) : null}
      {teamOpen && team.length > 0 ? (
        <ol data-team-activity className="border-t border-rule">
          {team.map((a) => (
            <RailRow key={a.id} when={formatWhen(a.at, today)}>
              <span className="text-label text-foreground">{teamLine(a)}</span>
            </RailRow>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
