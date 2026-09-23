import { createFileRoute } from '@tanstack/react-router'
import { EmbeddingsSection } from '#/components/settings/embeddings-section'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { getEmbeddingSettings, getSession } from '#/lib/server-fns'

/**
 * Settings → Embeddings (SPA-51, `docs/spec-ai-substrate.md` §9) — the
 * workspace's embedding pin, a child route of the settings shell like every
 * section. Admin-only: the loader asks for the pin and the keys only when the
 * reader is an admin, since the server fns refuse anyone else, and a member
 * who types the URL reads a sentence instead of an error.
 */
export const Route = createFileRoute('/_app/settings/embeddings')({
  loader: async () => {
    const session = await getSession()
    if (session?.user.role !== 'admin') return { settings: null }
    return { settings: await getEmbeddingSettings() }
  },
  component: EmbeddingsRoute,
})

function EmbeddingsRoute() {
  const { settings } = Route.useLoaderData()
  if (settings) return <EmbeddingsSection settings={settings} />
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
