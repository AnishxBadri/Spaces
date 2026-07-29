import { createFileRoute } from '@tanstack/react-router'
import { Users } from 'lucide-react'
import { EmptyState } from '#/components/empty-state'

export const Route = createFileRoute('/_app/people')({
  component: () => (
    <EmptyState
      icon={Users}
      title="People"
      body="Founders, operators, co-investors — with the relationship graph underneath: who knows whom, how warmly, and through which threads."
      hint="Fills itself once Gmail sync lands; manual contacts arrive with the entity workbench."
    />
  ),
})
