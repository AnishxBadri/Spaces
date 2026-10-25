import { createFileRoute } from '@tanstack/react-router'
import { EnrichmentSection } from '#/components/settings/enrichment-section'
import { getEnrichmentPage } from '#/lib/server-fns'

/**
 * Settings → Integrations → Enrichment: the sources in order,
 * auto-enrich, What fills what and the recent runs. A member reads it too,
 * every control disabled.
 */
export const Route = createFileRoute('/_app/settings/enrichment')({
  loader: async () => ({ page: await getEnrichmentPage() }),
  component: EnrichmentRoute,
})

function EnrichmentRoute() {
  const { page } = Route.useLoaderData()
  return <EnrichmentSection page={page} />
}
