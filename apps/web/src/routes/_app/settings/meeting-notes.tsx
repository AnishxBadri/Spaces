import { createFileRoute } from '@tanstack/react-router'
import { MeetingNotesSection } from '#/components/settings/accounts-section'

/** Settings → You → Meeting notes: the reader's recorder connections. (D81) */
export const Route = createFileRoute('/_app/settings/meeting-notes')({
  component: MeetingNotesSection,
})
