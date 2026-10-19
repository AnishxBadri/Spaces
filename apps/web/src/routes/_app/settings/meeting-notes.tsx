import { createFileRoute } from '@tanstack/react-router'
import { MeetingNotesSection } from '#/components/settings/meeting-notes-section'
import { getMeetingNotes } from '#/lib/server-fns'

/** Settings → You → Meeting notes: the reader's recorder keys and their folders. (D78, D81) */
export const Route = createFileRoute('/_app/settings/meeting-notes')({
  loader: () => getMeetingNotes(),
  component: MeetingNotesRoute,
})

function MeetingNotesRoute() {
  return <MeetingNotesSection view={Route.useLoaderData()} />
}
