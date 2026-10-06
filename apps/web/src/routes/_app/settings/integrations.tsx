import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { IntegrationLedger } from '#/components/integrations/integration-ledger'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import {
  getSession,
  listIntegrations,
  resetIntegration,
  setIntegrationEnabled,
} from '#/lib/server-fns'
import type { IntegrationRow } from '#/lib/server-fns'

/**
 * Settings → Integrations: the installed plugins as a ledger, each with its
 * switch, state and the one action its state calls for. Admin-only: the
 * loader asks for the rows only when the reader is an admin, since the
 * server fns refuse anyone else, and a member who types the URL reads a
 * sentence instead of an error.
 */
export const Route = createFileRoute('/_app/settings/integrations')({
  loader: async () => {
    const session = await getSession()
    if (session?.user.role !== 'admin') return { rows: null }
    return { rows: await listIntegrations() }
  },
  component: IntegrationsRoute,
})

function IntegrationsRoute() {
  const { rows } = Route.useLoaderData()
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)

  async function act(
    row: IntegrationRow,
    run: () => Promise<void>,
    done: string,
  ) {
    setPending(row.id)
    try {
      await run()
      toast(done)
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(null)
    }
  }

  if (rows === null)
    return (
      <SettingsSection title="Integrations" crumb="Data & AI">
        <SettingsRow
          label="Admins only"
          hint="Plugins and their keys belong to the workspace admin."
        />
      </SettingsSection>
    )

  return (
    <SettingsSection title="Integrations" crumb="Data & AI">
      <IntegrationLedger
        rows={rows}
        actions={{
          pending,
          onToggle: (row, enabled) =>
            void act(
              row,
              () => setIntegrationEnabled({ data: { id: row.id, enabled } }),
              enabled ? `${row.name} on` : `${row.name} off · key kept`,
            ),
          onReset: (row) =>
            void act(
              row,
              () => resetIntegration({ data: { id: row.id } }),
              `${row.name} reset · reloading`,
            ),
        }}
      />
    </SettingsSection>
  )
}
