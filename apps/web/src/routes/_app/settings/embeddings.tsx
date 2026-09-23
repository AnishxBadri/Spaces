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
 * Settings → Embeddings (SPA-51, `docs/spec-ai-substrate.md` §9) — the
 * workspace's embedding pin and, since SPA-136, the corpus backfill, a child
 * route of the settings shell like every section. Admin-only: the loader
 * asks for the pin, the keys and the backfill's estimate only when the
 * reader is an admin, since the server fns refuse anyone else, and a member
 * who types the URL reads a sentence instead of an error. The estimate is
 * database reads; loading this page never calls a provider.
 */
export const Route = createFileRoute('/_app/settings/embeddings')({
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
      title="Embeddings"
      blurb="Which model turns text into vectors for search."
      crumb="Workspace"
    >
      <SettingsRow
        label="Admins only"
        hint="The embedding pin and its key belong to the workspace admin."
      />
    </SettingsSection>
  )
}
