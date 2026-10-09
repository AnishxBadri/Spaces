import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

/**
 * Settings → Integrations: the installed plugins, one plugin's settings and
 * key, on/off and breaker reset, the registry's Install, Update and
 * Uninstall, and Upload for a box with no outbound HTTPS. Admin only — every
 * handler opens with `requireAdmin()`; the bodies are imported inside the
 * handlers so their database code never reaches the client bundle.
 */

export type {
  AutoEnrichView,
  IntegrationDetail,
  IntegrationRow,
  IntegrationState,
  SecretField,
  SecretSlot,
  SpaceOption,
} from '../integrations/ledger'
export type { AutoEnrichScopeName } from '@spaces/core/plugins/auto-enrich'
export type { SettingsSaved } from '../integrations/admin'
export type {
  AvailablePlugin,
  InstallOutcome,
  RegistryView,
} from '../integrations/install'
export type {
  FormValue,
  FormValues,
  SettingsField,
  SettingsForm,
} from '../integrations/settings-form'

const byId = z.object({ id: z.string().uuid() })

/** Every installed plugin with its state, last run and today's credits. */
export const listIntegrations = createServerFn().handler(async () => {
  const { listIntegrationsHandler } = await import('../integrations/admin')
  return listIntegrationsHandler()
})

/** How many plugins are installed, for the settings nav. */
export const countIntegrations = createServerFn().handler(async () => {
  const { countIntegrationsHandler } = await import('../integrations/admin')
  return countIntegrationsHandler()
})

/** One plugin: its row, its settings form prefilled from config, its key fields. */
export const getIntegration = createServerFn()
  .validator(byId)
  .handler(async ({ data }) => {
    const { getIntegrationHandler } = await import('../integrations/admin')
    return getIntegrationHandler(data)
  })

/** The operator's switch; the worker registers or unregisters its queues. */
export const setIntegrationEnabled = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), enabled: z.boolean() }))
  .handler(async ({ data }) => {
    const { setIntegrationEnabledHandler } =
      await import('../integrations/admin')
    return setIntegrationEnabledHandler(data)
  })

/** Clears a tripped breaker and reloads the plugin. */
export const resetIntegration = createServerFn({ method: 'POST' })
  .validator(byId)
  .handler(async ({ data }) => {
    const { resetIntegrationHandler } = await import('../integrations/admin')
    return resetIntegrationHandler(data)
  })

/** Writes `integration.config`, or returns each failing field's message and writes nothing. */
export const saveIntegrationSettings = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      values: z.record(z.string(), z.union([z.string(), z.boolean()])),
    }),
  )
  .handler(async ({ data }) => {
    const { saveIntegrationSettingsHandler } =
      await import('../integrations/admin')
    return saveIntegrationSettingsHandler(data)
  })

/** Writes the auto-enrich scope: which triggers run the plugin's event jobs. */
export const saveIntegrationAutoEnrich = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      scopes: z.array(z.enum(['deal', 'space', 'meeting'])).max(3),
      spaces: z.array(z.string().uuid()).max(500),
    }),
  )
  .handler(async ({ data }) => {
    const { saveIntegrationAutoEnrichHandler } =
      await import('../integrations/admin')
    return saveIntegrationAutoEnrichHandler({
      id: data.id,
      scope: { scopes: data.scopes, spaces: data.spaces },
    })
  })

const secretSlot = z.enum(['credential', 'webhook'])

/** Stores the pasted key or webhook secret in the vault; returns only its redacted display. */
export const saveIntegrationSecret = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      slot: secretSlot,
      secret: z.string().min(1).max(4000),
    }),
  )
  .handler(async ({ data }) => {
    const { saveIntegrationSecretHandler } =
      await import('../integrations/admin')
    return saveIntegrationSecretHandler(data)
  })

/** What the registry offers that is not installed. */
export const listAvailableIntegrations = createServerFn().handler(async () => {
  const { listAvailableHandler } = await import('../integrations/install')
  return listAvailableHandler()
})

/** Fetches, verifies and unpacks the registry's newest version; the worker enables it. */
export const installIntegration = createServerFn({ method: 'POST' })
  .validator(z.object({ pluginId: z.string().min(1).max(64) }))
  .handler(async ({ data }) => {
    const { installIntegrationHandler } =
      await import('../integrations/install')
    return installIntegrationHandler(data)
  })

/**
 * The upload's two files from the form: one `.tgz`, and at most one `.json`
 * (the entry its release published). `FormData` is the transport TanStack
 * Start reads natively for a POST.
 */
function readUploadForm(data: FormData): { tarball: File; entry: File | null } {
  const files = data.getAll('file').filter((f) => f instanceof File)
  const tarballs = files.filter((f) => f.name.endsWith('.tgz'))
  const entries = files.filter((f) => f.name.endsWith('.json'))
  if (tarballs.length !== 1 || entries.length > 1)
    throw new Error('Choose one .tgz, and the .json entry published beside it')
  if (tarballs.length + entries.length !== files.length)
    throw new Error(
      'A plugin upload is a .tgz and its .json entry, nothing else',
    )
  return { tarball: tarballs[0], entry: entries.at(0) ?? null }
}

/** Verifies and installs an uploaded tarball through the registry install's installer. */
export const uploadIntegration = createServerFn({ method: 'POST' })
  .validator((data: FormData) => readUploadForm(data))
  .handler(async ({ data }) => {
    const { uploadIntegrationHandler } = await import('../integrations/install')
    return uploadIntegrationHandler(data)
  })

/** Moves an installed plugin to the registry's newest version, keeping one back. */
export const updateIntegration = createServerFn({ method: 'POST' })
  .validator(byId)
  .handler(async ({ data }) => {
    const { upgradeIntegrationHandler } =
      await import('../integrations/install')
    return upgradeIntegrationHandler(data)
  })

/** Deletes the files and the key; the row stays, soft-deleted, so what it wrote still names it. */
export const uninstallIntegration = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), dropData: z.boolean() }))
  .handler(async ({ data }) => {
    const { uninstallIntegrationHandler } =
      await import('../integrations/install')
    return uninstallIntegrationHandler(data)
  })

/** Deletes a slot's secret; without its key the row reads degraded('missing credential'). */
export const removeIntegrationSecret = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), slot: secretSlot }))
  .handler(async ({ data }) => {
    const { removeIntegrationSecretHandler } =
      await import('../integrations/admin')
    return removeIntegrationSecretHandler(data)
  })
