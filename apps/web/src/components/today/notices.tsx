import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { reasonOf } from '#/components/plugin-status-section'
import type {
  BrokenConnection,
  ParkedSource,
  StoppedPlugin,
  WaitingExport,
} from '#/lib/server-fns'

const PLUGIN_STATE: Record<StoppedPlugin['state'], string> = {
  tripped: 'stopped',
  degraded: 'degraded',
  capped: 'at its credit cap',
}

function NoticeLine({
  lane,
  what,
  why,
  fix,
}: {
  lane: string
  what: string
  why: string | null
  fix: ReactNode
}) {
  return (
    <li className="flex h-row items-center gap-3 border-b border-rule px-3 last:border-b-0">
      <span className="w-12 shrink-0 mono text-micro text-destructive">
        {lane}
      </span>
      <span className="shrink-0 text-ui text-foreground">{what}</span>
      {why ? (
        <span className="min-w-0 truncate mono text-micro text-graphite">
          {why}
        </span>
      ) : null}
      <span className="flex-1" />
      {fix}
    </li>
  )
}

const fixClass =
  'focus-ring shrink-0 mono text-micro text-primary hover:underline'

/** `00:00 UTC` — the reset, read off the ISO instant so server and client agree. */
const utcClock = (iso: string) => `${iso.slice(11, 16)} UTC`

/**
 * What stops the machine, one line each with the link that fixes it: a
 * plugin switched on and not running or capped, auto-enrich parked at a
 * source's daily cap, the reader's connections in `error`, and uploads
 * waiting to reach a bound folder. Renders nothing when all runs.
 */
export function NoticesBand({
  stopped,
  broken,
  parked,
  waiting,
}: {
  stopped: ReadonlyArray<StoppedPlugin>
  broken: ReadonlyArray<BrokenConnection>
  parked: ReadonlyArray<ParkedSource>
  waiting: ReadonlyArray<WaitingExport>
}) {
  if (
    stopped.length === 0 &&
    broken.length === 0 &&
    parked.length === 0 &&
    waiting.length === 0
  )
    return null
  return (
    <section aria-label="Notices" className="border border-hairline bg-paper">
      <ul>
        {broken.map((c) => (
          <NoticeLine
            key={c.connectionId}
            lane="account"
            what={`${c.label} needs reconnecting`}
            why={c.errorReason ?? c.externalEmail}
            fix={
              <Link to={c.fixTo} className={fixClass}>
                reconnect ›
              </Link>
            }
          />
        ))}
        {waiting.map((w) => (
          <NoticeLine
            key={`waiting:${w.provider}`}
            lane="files"
            what={`${String(w.count)} ${w.count === 1 ? 'file' : 'files'} waiting for a ${w.label} connection`}
            why={null}
            fix={
              <Link to={w.fixTo} className={fixClass}>
                reconnect ›
              </Link>
            }
          />
        ))}
        {parked.map((p) => (
          <NoticeLine
            key={`parked:${p.integrationId}`}
            lane="enrich"
            what={`Auto-enrich paused · ${p.source} cap reached`}
            why={`${String(p.waiting)} waiting · resumes ${utcClock(p.resumesAt)}`}
            fix={
              <Link
                to="/settings/plugins/$integrationId"
                params={{ integrationId: p.integrationId }}
                className={fixClass}
              >
                cap ›
              </Link>
            }
          />
        ))}
        {stopped.map((p) => (
          <NoticeLine
            key={`${p.integrationId}:${p.state}`}
            lane="plugin"
            what={`${p.pluginId} ${PLUGIN_STATE[p.state]}`}
            why={reasonOf(p)}
            fix={
              <Link
                to="/settings/plugins/$integrationId"
                params={{ integrationId: p.integrationId }}
                className={fixClass}
              >
                fix ›
              </Link>
            }
          />
        ))}
      </ul>
    </section>
  )
}
