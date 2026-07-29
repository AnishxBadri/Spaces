import { createFileRoute } from '@tanstack/react-router'
import { FileText } from 'lucide-react'
import { EmptyState } from '#/components/empty-state'

export const Route = createFileRoute('/_app/notes')({
  component: () => (
    <EmptyState
      icon={FileText}
      title="Notes"
      body="Research lives here — markdown with [[mentions]] that link companies, spaces, and theses into one graph. Backlinks come free."
      hint="The editor is next; notes will read like a page, not a dashboard."
    />
  ),
})
