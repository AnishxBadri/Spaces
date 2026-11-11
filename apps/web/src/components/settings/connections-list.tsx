import { Link } from '@tanstack/react-router'
import { Square } from '#/components/icons'
import { ProviderMark } from '#/components/provider-mark'
import type { ReactNode } from 'react'
import {
  SETTINGS_LINK,
  SettingsGroup,
  SettingsSection,
  SettingsState,
} from './settings-section'
import type { SettingsTone } from './settings-section'
import type { ProviderId } from '@spaces/core/providers/registry'
import { listStatusOf } from '#/lib/connections/provider-view'
import type { ConnectionsListRow } from '#/lib/server-fns'

const ICON: Record<ProviderId, ReactNode> = {
  google: <ProviderMark brand="google" />,
  box: <ProviderMark brand="box" />,
}

/** The status square: hollow until set up, crimson while broken. */
function toneOf(row: ConnectionsListRow): SettingsTone {
  if (!row.configured) return 'wait'
  return row.error === null ? 'ok' : 'bad'
}

const ROW = 'flex h-12 items-center gap-3 border-b border-rule px-(--inset)'

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
    <SettingsSection
      title="Connections"
      meta={`${String(set)} of ${String(rows.length)} set up`}
    >
      <SettingsGroup label="Providers">
        {rows.map((row) => {
          const status = listStatusOf(row)
          return (
            <div
              key={row.provider}
              data-provider={row.provider}
              className={ROW}
            >
              <span className="flex w-5 shrink-0 justify-center text-graphite">
                {ICON[row.provider]}
              </span>
              <span className="min-w-0 flex-1 truncate text-ui font-medium">
                {row.label}
              </span>
              <SettingsState
                tone={toneOf(row)}
                className="w-[16.25rem] shrink-0"
              >
                {status.text}
              </SettingsState>
              <span className="flex w-[4.5rem] shrink-0 justify-end">
                <Link
                  to="/settings/connections/$provider"
                  params={{ provider: row.provider }}
                  search={{ tab: status.link.tab }}
                  className={SETTINGS_LINK}
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
          <SettingsState tone="off" className="w-[16.25rem] shrink-0">
            Not available yet
          </SettingsState>
          <span className="w-[4.5rem] shrink-0" />
        </div>
      </SettingsGroup>
    </SettingsSection>
  )
}
