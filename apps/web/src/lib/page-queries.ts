import { queryOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { getHolding, listHoldings } from '#/lib/server-fns'

/**
 * Page data as keyed queries. A route's loader `ensureQueryData`s the
 * options here with `revalidateIfStale`, its component reads them with
 * `useSuspenseQuery`, and a write invalidates the keys it touched. Every key
 * is built by a function in this module, so a key is never a string typed at
 * a call site and the prefix a write invalidates is the tuple the read
 * cached under.
 *
 * The loader is where page data refreshes, never the mount
 * (`refetchOnMount: false`): a page opened again paints what the cache holds
 * and reads the database behind it, and the first paint hydrates its
 * dehydrated cache with no refetch however long hydration takes.
 */
const PAGE_QUERY = {
  /** A hover's preload and the click after it share one read. */
  staleTime: 5_000,
  refetchOnMount: false,
} as const

export const portfolioKeys = {
  /** Every Portfolio key: the prefix a Portfolio write invalidates. */
  all: () => ['portfolio'] as const,
  list: () => ['portfolio', 'list'] as const,
  /** One holding as it stood on `asOf`, or as it stands today. */
  holding: (id: string, asOf?: string) =>
    ['portfolio', 'holding', id, asOf ?? null] as const,
}

export const portfolioQueries = {
  list: () =>
    queryOptions({
      queryKey: portfolioKeys.list(),
      queryFn: () => listHoldings(),
      ...PAGE_QUERY,
    }),
  holding: (id: string, asOf?: string) =>
    queryOptions({
      queryKey: portfolioKeys.holding(id, asOf),
      queryFn: () =>
        getHolding({ data: { id, ...(asOf === undefined ? {} : { asOf }) } }),
      ...PAGE_QUERY,
    }),
}

/**
 * After a Portfolio write (a check, a mark, a distribution, a round, a
 * void): the list and every holding are stale. The ones on screen refetch
 * now; the rest when their page next loads.
 */
export function refreshPortfolio(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: portfolioKeys.all() })
}
