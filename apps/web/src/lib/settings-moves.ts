import { redirect } from '@tanstack/react-router'

/**
 * The `beforeLoad` of each settings path that moved when the sections were
 * regrouped by whose they are (D81): one permanent redirect to its new home,
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

export function toEmailCalendar({ search }: { search: Search }): never {
  throw redirect({
    to: '/settings/email-calendar',
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
