import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { reasonOf } from '#/components/plugin-status-section'
import type {
  BrokenConnection,
  FailingBinding,
  ParkedSource,
  StoppedPlugin,
  WaitingExport,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/** Amber when the machine waits and will resume; rose when it has stopped. */
type Tone = 'warn' | 'bad'

const PLUGIN_STATE: Record<StoppedPlugin['state'], string> = {
  tripped: 'stopped',
  degraded: 'degraded',
  capped: 'at its credit cap',
}

const PLUGIN_TONE: Record<StoppedPlugin['state'], Tone> = {
  tripped: 'bad',
  degraded: 'bad',
  capped: 'warn',
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `00:00 UTC`: the cap resets on the UTC day, so the reader is told so. */
function utcTime(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

function NoticeLine({
  tone,
  children,
  fix,
}: {
  tone: Tone
  /** The sentence: what stopped, then why, joined by ` · `. */
  children: string
  fix: ReactNode
}) {
  return (
    <li
      data-notice={tone}
      className="flex h-8.5 items-center gap-2 border-b border-rule px-3 last:border-b-0"
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0',
          tone === 'warn' ? 'bg-warning' : 'bg-destructive',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-ui text-foreground">
        {children}
      </span>
      {fix}
    </li>
  )
}

const fixClass =
  'focus-ring shrink-0 mono text-micro text-foreground hover:underline'

/** `what · why`, leaving out a missing why. */
const sentence = (what: string, why: string | null) =>
  why === null || why === '' ? what : `${what} · ${why}`

/**
 * What stops the machine, one line each with the link that fixes it: a
 * plugin switched on and not running or capped, auto-enrich parked at a
 * source's daily cap, the reader's connections in `error`, bound folders
 * that cannot sync, and uploads waiting to reach a bound folder. Renders
 * nothing when all runs.
 */
export function NoticesBand({
  stopped,
  broken,
  parked,
  waiting,
  failing,
}: {
  stopped: ReadonlyArray<StoppedPlugin>
  broken: ReadonlyArray<BrokenConnection>
  parked: ReadonlyArray<ParkedSource>
  waiting: ReadonlyArray<WaitingExport>
  failing: ReadonlyArray<FailingBinding>
}) {
  if (
    stopped.length === 0 &&
    broken.length === 0 &&
    parked.length === 0 &&
    waiting.length === 0 &&
    failing.length === 0
  )
    return null
  return (
    <section aria-label="Notices" className="border border-rule bg-bone">
      <ul>
        {broken.map((c) => (
          <NoticeLine
            key={c.connectionId}
            tone="bad"
            fix={
              <Link to={c.fixTo} className={fixClass}>
                Reconnect ›
              </Link>
            }
          >
            {sentence(
              `${c.label} stopped syncing`,
              c.errorReason ?? c.externalEmail,
            )}
          </NoticeLine>
        ))}
        {failing.map((b) => (
          <NoticeLine
            key={`failing:${b.bindingId}`}
            tone="bad"
            fix={
              b.fixConnectionId === null ? (
                <Link to="/settings/files" className={fixClass}>
                  Fix ›
                </Link>
              ) : (
                <Link
                  to="/settings/files/$connectionId"
                  params={{ connectionId: b.fixConnectionId }}
                  className={fixClass}
                >
                  Fix ›
                </Link>
              )
            }
          >
            {sentence(`${b.title} can’t sync`, b.error)}
          </NoticeLine>
        ))}
        {waiting.map((w) => (
          <NoticeLine
            key={`waiting:${w.provider}`}
            tone="warn"
            fix={
              <Link to={w.fixTo} className={fixClass}>
                Files ›
              </Link>
            }
          >
            {`${String(w.count)} ${w.count === 1 ? 'file' : 'files'} waiting for a ${w.label} connection`}
          </NoticeLine>
        ))}
        {parked.map((p) => (
          <NoticeLine
            key={`parked:${p.integrationId}`}
            tone="warn"
            fix={
              <Link to="/settings/enrichment" className={fixClass}>
                Enrichment ›
              </Link>
            }
          >
            {`Auto-enrich paused · ${p.source} limit reached · ${String(p.waiting)} waiting · runs at ${utcTime(p.resumesAt)}`}
          </NoticeLine>
        ))}
        {stopped.map((p) => (
          <NoticeLine
            key={`${p.integrationId}:${p.state}`}
            tone={PLUGIN_TONE[p.state]}
            fix={
              <Link
                to="/settings/plugins/$integrationId"
                params={{ integrationId: p.integrationId }}
                className={fixClass}
              >
                Fix ›
              </Link>
            }
          >
            {sentence(
              `Plugin ${p.pluginId} ${PLUGIN_STATE[p.state]}`,
              reasonOf(p),
            )}
          </NoticeLine>
        ))}
      </ul>
    </section>
  )
}
