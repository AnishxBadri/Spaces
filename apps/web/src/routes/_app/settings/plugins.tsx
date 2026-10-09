import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { IntegrationLedger } from '#/components/integrations/integration-ledger'
import {
  RegistryPane,
  UploadPlugin,
} from '#/components/integrations/registry-pane'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import {
  getSession,
  installIntegration,
  listAvailableIntegrations,
  listIntegrations,
  resetIntegration,
  setIntegrationEnabled,
  updateIntegration,
  uploadIntegration,
} from '#/lib/server-fns'
import type { InstallOutcome, IntegrationRow } from '#/lib/server-fns'

/**
 * Settings → Integrations → Plugins: the installed plugins as a ledger, each with its
 * switch, state and the one action its state calls for, then what the
 * registry offers, each with Install; Upload in the head takes a tarball
 * from disk for a box with no outbound HTTPS. Admin-only: the
 * loader asks for the rows only when the reader is an admin, since the
 * server fns refuse anyone else, and a member who types the URL reads a
 * sentence instead of an error.
 */
export const Route = createFileRoute('/_app/settings/plugins')({
  loader: async () => {
    const session = await getSession()
    if (session?.user.role !== 'admin') return { rows: null, registry: null }
    const [rows, registry] = await Promise.all([
      listIntegrations(),
      listAvailableIntegrations(),
    ])
    return { rows, registry }
  },
  component: IntegrationsRoute,
})

/** What `pending` holds while an upload is in flight; never a row id or plugin id. */
const UPLOAD = ':upload'

function IntegrationsRoute() {
  const { rows, registry } = Route.useLoaderData()
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

  /** The toast an install or update earns: the version, and any caveat. */
  const landed = (o: InstallOutcome, verb: string) =>
    [`${o.name} ${o.version ?? ''} ${verb} · the worker is loading it`]
      .concat(o.warning === null ? [] : [o.warning])
      .join(' · ')

  async function install(pluginId: string) {
    setPending(pluginId)
    try {
      const outcome = await installIntegration({ data: { pluginId } })
      toast(landed(outcome, 'installed'))
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not install')
    } finally {
      setPending(null)
    }
  }

  async function upload(files: ReadonlyArray<File>) {
    setPending(UPLOAD)
    try {
      const form = new FormData()
      for (const file of files) form.append('file', file)
      const outcome = await uploadIntegration({ data: form })
      toast(landed(outcome, 'installed'))
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not upload')
    } finally {
      setPending(null)
    }
  }

  if (rows === null)
    return (
      <SettingsSection title="Plugins" crumb="Integrations">
        <SettingsRow
          label="Admins only"
          hint="Plugins and their keys belong to the workspace admin."
        />
      </SettingsSection>
    )

  return (
    <SettingsSection
      title="Plugins"
      crumb="Integrations"
      action={
        <UploadPlugin
          pending={pending === UPLOAD}
          disabled={pending !== null}
          onUpload={(files) => void upload(files)}
        />
      }
    >
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
          onUpdate: (row) =>
            void act(
              row,
              async () => {
                await updateIntegration({ data: { id: row.id } })
              },
              `${row.name} updated to ${row.update ?? 'the newest version'} · reloading`,
            ),
        }}
      />
      <RegistryPane
        view={registry}
        pending={pending}
        onInstall={(plugin) => void install(plugin.pluginId)}
      />
    </SettingsSection>
  )
}
