import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { IntegrationLedger } from '#/components/integrations/integration-ledger'
import {
  RegistryPane,
  UploadPlugin,
} from '#/components/integrations/registry-pane'
import {
  SettingsSection,
  useSettingsPage,
} from '#/components/settings/settings-section'
import {
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
 * Settings → Integrations → Plugins, a catalogue: the installed plugins as a
 * ledger, each with its switch, jobs, state and one number, and `Open ›`;
 * then Available from the registry in tabs by job, each with Install. Upload
 * in the head takes a tarball from disk for a box with no outbound HTTPS.
 * A member reads the same catalogue with every write disabled.
 * - Available sits outside the section's disabled fieldset so a member can
 *   still switch its tabs; its Install takes `disabled` instead.
 */
export const Route = createFileRoute('/_app/settings/plugins')({
  loader: async () => {
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
  const page = useSettingsPage()
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

  // One column: the section and Available sit flush, no shell gap between.
  return (
    <div className="flex flex-col">
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
      </SettingsSection>
      <RegistryPane
        view={registry}
        pending={pending}
        disabled={!page.isAdmin}
        onInstall={(plugin) => void install(plugin.pluginId)}
      />
    </div>
  )
}
