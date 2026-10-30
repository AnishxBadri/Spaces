import { redirect } from '@tanstack/react-router'
import type { ProviderId } from '@spaces/core/providers/registry'
import { providerOfPlugin } from '#/lib/connections/products'
import { getIntegration } from '#/lib/server-fns'

/**
 * The `beforeLoad` of each settings path that moved when the sections were
 * regrouped by whose they are: one permanent redirect to its new home,
 * query intact, so bookmarks and old links land where the section went.
 *
 * - 301, not the 307 default: the move is a decision, not a condition.
 * - `replace` keeps the old path out of the back stack.
 */

type Search = Record<string, unknown>

export function toGeneral({ search }: { search: Search }): never {
  throw redirect({
    to: '/settings/general',
    search,
    statusCode: 301,
    replace: true,
  })
}

export function toModels({ search }: { search: Search }): never {
  throw redirect({
    to: '/settings/models',
    search,
    statusCode: 301,
    replace: true,
  })
}

export function toSearch({ search }: { search: Search }): never {
  throw redirect({
    to: '/settings/search',
    search,
    statusCode: 301,
    replace: true,
  })
}

export function toEmailForwarding({ search }: { search: Search }): never {
  throw redirect({
    to: '/settings/email-forwarding',
    search,
    statusCode: 301,
    replace: true,
  })
}

export function toConnections({ search }: { search: Search }): never {
  throw redirect({
    to: '/settings/connections',
    search,
    statusCode: 301,
    replace: true,
  })
}

export function toPlugins({ search }: { search: Search }): never {
  throw redirect({
    to: '/settings/plugins',
    search,
    statusCode: 301,
    replace: true,
  })
}

export function toPlugin({
  params,
  search,
}: {
  params: { integrationId: string }
  search: Search
}): never {
  throw redirect({
    to: '/settings/plugins/$integrationId',
    params: { integrationId: params.integrationId },
    search,
    statusCode: 301,
    replace: true,
  })
}

/** A bundled plugin has no plugin page: its switch and its runs are its provider's In use tab. */
export function toProviderInUse(provider: ProviderId): never {
  throw redirect({
    to: '/settings/connections/$provider',
    params: { provider },
    search: { tab: 'in-use' },
    statusCode: 301,
    replace: true,
  })
}

/**
 * The plugin page's `beforeLoad`: `/settings/plugins/gmail` names a bundled
 * plugin by id, and lands on its provider. A row id passes; the loader
 * sends a bundled row the same way once it has read it.
 */
export function toProviderIfBundled({
  params,
}: {
  params: { integrationId: string }
}): void {
  const provider = providerOfPlugin(params.integrationId)
  if (provider !== null) toProviderInUse(provider)
}

/** The plugin page's loader: a row read as a bundled plugin lands on its provider. */
export async function loadPluginPage(integrationId: string) {
  const detail = await getIntegration({ data: { id: integrationId } })
  const provider = providerOfPlugin(detail.pluginId)
  if (provider !== null) toProviderInUse(provider)
  return { detail }
}
