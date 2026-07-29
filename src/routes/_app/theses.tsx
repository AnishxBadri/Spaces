import { createFileRoute } from '@tanstack/react-router'
import { Target } from 'lucide-react'
import { EmptyState } from '#/components/empty-state'

export const Route = createFileRoute('/_app/theses')({
  component: () => (
    <EmptyState
      icon={Target}
      title="Theses"
      body="Claims you hold, with conviction and evidence on both sides. A killed thesis keeps its reasoning — being wrong on the record is the point."
      hint="Opens once spaces exist to hang claims on."
    />
  ),
})
