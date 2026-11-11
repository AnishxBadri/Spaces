import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { productBrand } from './accounts-section'
import { ProviderSetup } from './provider-setup'
import {
  SETTINGS_LINK,
  SettingsBack,
  SettingsColumns,
  SettingsGroup,
  SettingsGroupHead,
  SettingsSection,
  SettingsState,
  useSettingsPage,
} from './settings-section'
import { EmptyRow } from '#/components/ledger-section'
import { ProviderMark } from '#/components/provider-mark'
import { Switch } from '#/components/ui/switch'
import { Tabs } from '#/components/ui/tabs'
import { useClock } from '#/components/clock'
import { JOB_PAGE, productOf } from '#/lib/connections/products'
import { healthOf, whoLineOf } from '#/lib/connections/provider-view'
import type { ProviderTab } from '#/lib/connections/provider-view'
import type { ProviderPageView, ProviderUse } from '#/lib/server-fns'
import type { ProviderId } from '@spaces/core/providers/registry'
import { setIntegrationEnabled } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

const ROW = 'flex h-12 items-center gap-3 border-b border-rule px-(--inset)'

/**
 * A provider's page under Settings → Connections: the Set up tab (the
 * questions, the console steps, the client, a test connect) and the In use
 * tab (which uses members may use, and who is connected).
 * - A settings page has no folder: the tabs are the plain bar at the top of
 *   one rule card, the open tab's groups under it in the same card.
 */
export function ProviderPage({
  view,
  tab,
  onTab,
}: {
  view: ProviderPageView
  tab: ProviderTab
  onTab: (tab: ProviderTab) => void
}) {
  const page = useSettingsPage()
  // The tabs sit outside the section's fieldset so a member reading the page
  // can still switch them; the body takes the fieldset instead.
  return (
    <SettingsSection
      title={view.app.label}
      back={<SettingsBack to="/settings/connections">Connections</SettingsBack>}
      mark={
        <ProviderMark
          brand={productBrand(view.app.provider, view.app.provider)}
          className="size-6"
        />
      }
      after={
        <SettingsGroup label={`${view.app.label} connection`}>
          <Tabs<ProviderTab>
            label={`${view.app.label} connection`}
            plain
            items={[
              { id: 'setup', label: 'Set up', uncounted: true },
              { id: 'in-use', label: 'In use', uncounted: true },
            ]}
            value={tab}
            onValueChange={onTab}
            className="px-(--inset) pt-1"
          />
          <fieldset
            disabled={!page.isAdmin && page.adminOnly}
            className="contents"
          >
            {tab === 'setup' ? (
              <ProviderSetup view={view} />
            ) : (
              <ProviderInUse view={view} />
            )}
          </fieldset>
        </SettingsGroup>
      }
    >
      {null}
    </SettingsSection>
  )
}

/** In use: the uses members may use (each a bundled plugin's switch), then who is connected. */
export function ProviderInUse({ view }: { view: ProviderPageView }) {
  const navigate = useNavigate()
  const people = new Set(view.connected.map((c) => c.userId)).size
  const firstJob = view.uses
    .map((u) => productOf(view.app.provider, u.product)?.job)
    .find((job) => job !== undefined)
  const on = view.uses.filter((u) => u.enabled).length
  return (
    <div className="flex flex-col">
      <SettingsGroupHead
        title="Access"
        count={`${String(on)} of ${String(view.uses.length)} on`}
      />
      <SettingsColumns>
        <span className="w-6 shrink-0" />
        <span className="w-4 shrink-0" />
        <span className="w-36 shrink-0">Use</span>
        <span className="min-w-0 flex-1">Who</span>
        <span className="w-36 shrink-0">Health · 7 days</span>
        <span className="w-12 shrink-0" />
      </SettingsColumns>
      {view.uses.map((use) => (
        <UseRow key={use.product} provider={view.app.provider} use={use} />
      ))}
      <SettingsGroupHead
        title="Connected"
        count={`${String(people)} of ${String(view.members)}`}
      />
      {view.connected.length === 0 ? (
        <EmptyRow
          name="Connected"
          onAdd={() => void navigate({ to: JOB_PAGE[firstJob ?? 'files'] })}
        />
      ) : (
        <>
          <SettingsColumns>
            <span className="w-36 shrink-0">Member</span>
            <span className="min-w-0 flex-1">Email</span>
            <span className="w-36 shrink-0">Uses</span>
            <span className="w-28 shrink-0">State</span>
          </SettingsColumns>
          {view.connected.map((c) => (
            <div key={`${c.userId}:${c.email}`} className={ROW}>
              <span className="w-36 shrink-0 truncate text-ui font-medium">
                {c.name}
              </span>
              <span className="min-w-0 flex-1 truncate mono text-label text-graphite">
                {c.email}
              </span>
              <span className="w-36 shrink-0 truncate text-label text-graphite">
                {c.uses}
              </span>
              <SettingsState
                tone={c.state === 'ok' ? 'ok' : 'bad'}
                className="w-28 shrink-0"
              >
                {c.state === 'ok' ? 'In sync' : 'Token expired'}
              </SettingsState>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

/**
 * One use: its switch, who uses it, its week's health and its runs. Unticking
 * stops its syncs and keeps every row it wrote.
 */
function UseRow({ provider, use }: { provider: ProviderId; use: ProviderUse }) {
  const router = useRouter()
  const { now, today } = useClock()
  const [pending, setPending] = useState(false)
  const health = healthOf(use)
  const id = use.integrationId

  async function toggle(enabled: boolean) {
    if (id === null) return
    setPending(true)
    try {
      await setIntegrationEnabled({ data: { id, enabled } })
      toast(
        enabled
          ? `${use.label} on`
          : `${use.label} off · its syncs stop, nothing is removed`,
      )
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  return (
    <div data-use={use.plugin} className={ROW}>
      <span className="flex w-6 shrink-0">
        <Switch
          checked={use.enabled}
          disabled={pending || id === null}
          aria-label={`Members may use ${use.label}`}
          onCheckedChange={(next) => void toggle(next)}
        />
      </span>
      <ProviderMark
        brand={productBrand(provider, use.product)}
        className={use.enabled ? 'text-foreground' : 'text-graphite'}
      />
      <span className="w-36 shrink-0 truncate text-ui font-medium">
        {use.label}
      </span>
      <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
        {id === null
          ? 'Not in this image'
          : whoLineOf(use, new Date(now).getTime(), today)}
      </span>
      <span className="flex w-36 shrink-0">
        {use.enabled ? (
          <SettingsState tone={health.tone === 'ok' ? 'ok' : 'bad'}>
            {health.text}
          </SettingsState>
        ) : null}
      </span>
      <span className="flex w-12 shrink-0 justify-end">
        {id === null ? null : (
          <Link
            to="/settings/usage"
            search={{ integration: id }}
            className={cn(SETTINGS_LINK, 'shrink-0')}
          >
            Runs ›
          </Link>
        )}
      </span>
    </div>
  )
}
