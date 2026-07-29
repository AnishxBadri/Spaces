import { createFileRoute } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { EmptyState } from '#/components/empty-state'

export const Route = createFileRoute('/_app/settings')({
  component: () => (
    <EmptyState
      icon={Settings}
      title="Settings"
      body="Workspace, members and invitations, AI and enrichment keys, storage — all of it lives on this server, none of it phones home."
      hint="Members and API-key management arrive with invitations."
    />
  ),
})
