import { createFileRoute } from '@tanstack/react-router'
import { EmbeddingsSection } from '#/components/settings/embeddings-section'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import {
  getEmbedBackfill,
  getEmbeddingSettings,
  getSession,
} from '#/lib/server-fns'

/**
 * Settings → AI → Search: the workspace's embedding pin and the corpus
 * backfill. (D81)
 * - Admin-only: the loader asks only when the reader is an admin; a member
 *   who types the URL reads a sentence instead of an error.
 * - The estimate is database reads; loading this page never calls a provider.
 */
export const Route = createFileRoute('/_app/settings/search')({
  loader: async () => {
    const session = await getSession()
    if (session?.user.role !== 'admin') return { settings: null }
    const [settings, backfill] = await Promise.all([
      getEmbeddingSettings(),
      getEmbedBackfill(),
    ])
    return { settings: { settings, backfill } }
  },
  component: EmbeddingsRoute,
})

function EmbeddingsRoute() {
  const { settings } = Route.useLoaderData()
  if (settings)
    return (
      <EmbeddingsSection
        settings={settings.settings}
        backfill={settings.backfill}
      />
    )
  return (
    <SettingsSection
      title="Search"
      blurb="Which model turns text into vectors for search."
      crumb="AI"
    >
      <SettingsRow
        label="Admins only"
        hint="The embedding pin and its key belong to the workspace admin."
      />
    </SettingsSection>
  )
}
