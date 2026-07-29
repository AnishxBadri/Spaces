import { createFileRoute } from '@tanstack/react-router'
import { Kanban } from 'lucide-react'
import { EmptyState } from '#/components/empty-state'

export const Route = createFileRoute('/_app/pipeline')({
  component: () => (
    <EmptyState
      icon={Kanban}
      title="Pipeline"
      body="Deals move through stages on lists, not on the company — the same company can sit in a pipeline and the portfolio at once, with different fields in each."
      hint="Next up: the spreadsheet-grade table and kanban over the list/entry model."
    />
  ),
})
