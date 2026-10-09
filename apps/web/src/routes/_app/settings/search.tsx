import { createFileRoute } from '@tanstack/react-router'
import { EmbeddingsSection } from '#/components/settings/embeddings-section'
import { getEmbedBackfill, getEmbeddingSettings } from '#/lib/server-fns'

/**
 * Settings → AI → Search: the workspace's embedding pin and the corpus
 * backfill. (D81)
 * - A member reads it too, keys redacted and every control disabled.
 * - The estimate is database reads; loading this page never calls a provider.
 */
export const Route = createFileRoute('/_app/settings/search')({
  loader: async () => {
    const [settings, backfill] = await Promise.all([
      getEmbeddingSettings(),
      getEmbedBackfill(),
    ])
    return { settings, backfill }
  },
  component: EmbeddingsRoute,
})

function EmbeddingsRoute() {
  const { settings, backfill } = Route.useLoaderData()
  return <EmbeddingsSection settings={settings} backfill={backfill} />
}
