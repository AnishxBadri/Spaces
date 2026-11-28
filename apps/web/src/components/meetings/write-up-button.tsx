import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { useOpenNoteWindow } from '#/components/notes/note-window-nav'
import { Button } from '#/components/ui/button'
import { writeUpInteraction } from '#/lib/server-fns'

/**
 * `Write it up` on a past meeting with no write-up: writes one now through the
 * write-up program and opens it in the note window over the page, which
 * must mount `NoteModal`; `Done` steps back to where it was pressed.
 * Idempotent, so a second press opens the same note.
 */
export function WriteUpButton({ interactionId }: { interactionId: string }) {
  const router = useRouter()
  const openNote = useOpenNoteWindow()
  const [pending, setPending] = useState(false)
  async function write() {
    setPending(true)
    try {
      const { noteId } = await writeUpInteraction({ data: { interactionId } })
      void router.invalidate()
      openNote(noteId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not write it up')
    } finally {
      setPending(false)
    }
  }
  return (
    <Button
      variant="outline"
      size="sm"
      pending={pending}
      disabled={pending}
      onClick={() => void write()}
    >
      Write it up
    </Button>
  )
}
