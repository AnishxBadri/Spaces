import { Link } from '@tanstack/react-router'
import { Box, Mail, Square } from 'lucide-react'
import type { ReactNode } from 'react'
import { SettingsGroupHead, SettingsSection } from './settings-section'
import type { ProviderId } from '@spaces/core/providers/registry'
import { listStatusOf } from '#/lib/connections/provider-view'
import type { ConnectionsListRow } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

const ICON: Record<ProviderId, ReactNode> = {
  google: <Mail aria-hidden className="size-4" />,
  box: <Box aria-hidden className="size-4" />,
}

const TONE = {
  ink: 'text-foreground',
  graphite: 'text-graphite',
  bad: 'text-destructive',
} as const

const ROW = 'flex h-11 items-center gap-3 border-b border-rule px-3'

/**
 * Settings → Integrations → Connections: the providers whose OAuth app an
 * admin registers so members can connect their own accounts. One row each:
 * set up or not, how many members are connected, and the one link to its
 * page. Providers not built yet are listed so the absence is the news.
 */
export function ConnectionsList({
  rows,
}: {
  rows: ReadonlyArray<ConnectionsListRow>
}) {
  const set = rows.filter((r) => r.configured).length
  return (
    <SettingsSection title="Connections" crumb="Integrations">
      <SettingsGroupHead
        title="Providers"
        count={`${String(set)} of ${String(rows.length)} set up`}
      />
      {rows.map((row) => {
        const status = listStatusOf(row)
        return (
          <div key={row.provider} data-provider={row.provider} className={ROW}>
            <span className="flex w-5 shrink-0 justify-center text-graphite">
              {ICON[row.provider]}
            </span>
            <span className="min-w-0 flex-1 truncate text-ui font-medium">
              {row.label}
            </span>
            <span
              className={cn(
                'w-[16.25rem] shrink-0 truncate mono text-micro',
                TONE[status.tone],
              )}
            >
              {status.text}
            </span>
            <span className="flex w-[4.5rem] shrink-0 justify-end">
              <Link
                to="/settings/connections/$provider"
                params={{ provider: row.provider }}
                search={{ tab: status.link.tab }}
                className={cn(
                  'focus-ring rounded-md mono text-micro hover:underline',
                  status.tone === 'graphite'
                    ? 'text-graphite hover:text-foreground'
                    : 'text-foreground',
                )}
              >
                {status.link.label}
              </Link>
            </span>
          </div>
        )
      })}
      <div data-provider="microsoft" className={ROW}>
        <span className="flex w-5 shrink-0 justify-center text-graphite">
          <Square aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-graphite">
          Microsoft
        </span>
        <span className="w-[16.25rem] shrink-0 truncate mono text-micro text-graphite">
          Not available yet
        </span>
        <span className="w-[4.5rem] shrink-0" />
      </div>
    </SettingsSection>
  )
}
