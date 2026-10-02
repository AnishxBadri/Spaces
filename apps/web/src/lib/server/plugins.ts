import { createServerFn } from '@tanstack/react-start'
import { requireUser } from './shared'

/**
 * Plugin health for the app's surfaces. The program is imported inside the
 * handler so its database code never reaches the client bundle.
 */

export type { TrippedPlugin } from '../integrations/status'

/** Plugins the breaker turned off, for Today. */
export const listTrippedPlugins = createServerFn().handler(async () => {
  await requireUser()
  const { trippedPluginsProgram } = await import('../integrations/status')
  const { effectFn } = await import('./effect')
  return effectFn(trippedPluginsProgram)()
})
