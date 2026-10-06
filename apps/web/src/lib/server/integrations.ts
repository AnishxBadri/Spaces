import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

/**
 * Settings → Integrations: the installed plugins, one plugin's settings and
 * key, on/off and breaker reset. Admin only — every handler opens with
 * `requireAdmin()`; the bodies are imported inside the handlers so their
 * database code never reaches the client bundle.
 */

export type {
  IntegrationDetail,
  IntegrationRow,
  IntegrationState,
  SecretField,
} from '../integrations/ledger'
export type { SettingsSaved } from '../integrations/admin'
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

const secretSlot = z.enum(['credential'])

/** Stores the pasted key in the vault; returns only its redacted display. */
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

/** Deletes the key; the row reads degraded('missing credential'). */
export const removeIntegrationSecret = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), slot: secretSlot }))
  .handler(async ({ data }) => {
    const { removeIntegrationSecretHandler } =
      await import('../integrations/admin')
    return removeIntegrationSecretHandler(data)
  })
