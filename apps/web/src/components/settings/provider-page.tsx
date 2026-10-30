import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { ProviderSetup } from './provider-setup'
import {
  SettingsGroupHead,
  SettingsSection,
  useSettingsPage,
} from './settings-section'
import { EmptyRow } from '#/components/ledger-section'
import { Checkbox } from '#/components/ui/checkbox'
import { Tabs } from '#/components/ui/tabs'
import { useClock } from '#/components/clock'
import { JOB_PAGE, productOf } from '#/lib/connections/products'
import { healthOf, whoLineOf } from '#/lib/connections/provider-view'
import type { ProviderTab } from '#/lib/connections/provider-view'
import type { ProviderPageView, ProviderUse } from '#/lib/server-fns'
import { setIntegrationEnabled } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

const LINK =
  'focus-ring shrink-0 rounded-md mono text-micro text-foreground hover:underline'

/** A ledger's lane heads: sentence-case sans 12 graphite on hairlines. */
const HEAD =
  'flex h-8 items-center gap-3 border-b border-hairline px-3 text-label text-graphite'

const ROW = 'flex h-11 items-center gap-3 border-b border-rule px-3'

/**
 * A provider's page under Settings → Connections: the Set up tab (the
 * questions, the console steps, the client, a test connect) and the In use
 * tab (which uses members may use, and who is connected).
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
    <div className="flex flex-col">
      <SettingsSection title={view.app.label} crumb="Integrations">
        {null}
      </SettingsSection>
      <Tabs<ProviderTab>
        label={`${view.app.label} connection`}
        items={[
          { id: 'setup', label: 'Set up', uncounted: true },
          { id: 'in-use', label: 'In use', uncounted: true },
        ]}
        value={tab}
        onValueChange={onTab}
        className="mt-6"
      >
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
      </Tabs>
    </div>
  )
}

/** In use: the uses members may use (each a bundled plugin's switch), then who is connected. */
export function ProviderInUse({ view }: { view: ProviderPageView }) {
  const navigate = useNavigate()
  const people = new Set(view.connected.map((c) => c.userId)).size
  const firstJob = view.uses
    .map((u) => productOf(view.app.provider, u.product)?.job)
    .find((job) => job !== undefined)
  return (
    <div className="flex flex-col">
      <SettingsGroupHead title="Members may use" />
      <div className={HEAD}>
        <span className="w-4 shrink-0" />
        <span className="w-36 shrink-0">Use</span>
        <span className="min-w-0 flex-1">Who</span>
        <span className="w-36 shrink-0">Health</span>
        <span className="w-12 shrink-0" />
      </div>
      {view.uses.map((use) => (
        <UseRow key={use.product} use={use} />
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
          <div className={HEAD}>
            <span className="w-36 shrink-0">Member</span>
            <span className="min-w-0 flex-1">Email</span>
            <span className="w-36 shrink-0">Uses</span>
            <span className="w-28 shrink-0">State</span>
          </div>
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
              <span className="flex w-28 shrink-0 items-center gap-2 mono text-micro">
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 shrink-0',
                    c.state === 'ok' ? 'bg-primary' : 'bg-destructive',
                  )}
                />
                <span
                  className={
                    c.state === 'ok' ? 'text-foreground' : 'text-destructive'
                  }
                >
                  {c.state === 'ok' ? 'In sync' : 'Token expired'}
                </span>
              </span>
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
function UseRow({ use }: { use: ProviderUse }) {
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
      <Checkbox
        checked={use.enabled}
        disabled={pending || id === null}
        aria-label={`Members may use ${use.label}`}
        onCheckedChange={(next) => void toggle(next)}
      />
      <span className="w-36 shrink-0 truncate text-ui font-medium">
        {use.label}
      </span>
      <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
        {id === null
          ? 'Not in this image'
          : whoLineOf(use, new Date(now).getTime(), today)}
      </span>
      <span className="flex w-36 shrink-0 items-center gap-2 mono text-micro">
        {use.enabled ? (
          <>
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0',
                health.tone === 'ok' ? 'bg-primary' : 'bg-destructive',
              )}
            />
            <span
              className={cn(
                'truncate',
                health.tone === 'ok' ? 'text-foreground' : 'text-destructive',
              )}
            >
              {health.text}
            </span>
          </>
        ) : null}
      </span>
      <span className="flex w-12 shrink-0 justify-end">
        {id === null ? null : (
          <Link
            to="/settings/usage"
            search={{ integration: id }}
            className={LINK}
          >
            Runs ›
          </Link>
        )}
      </span>
    </div>
  )
}
