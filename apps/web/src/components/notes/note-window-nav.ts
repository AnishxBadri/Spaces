import { useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'

/**
 * Opening and closing a note's window over a page that is not a record
 * (`?modal=note&id=`): Meetings and Today.
 * - Opening pushes an entry, so closing steps back to the page exactly as
 *   it was, the meeting it was written from still open and its scroll kept.
 * - A close the opener did not push (a reload, a pasted link, a record's
 *   own opener) drops the keys where it stands.
 */

/** The history index of the entry the last opener pushed. */
let pushedAt: number | null = null

/** Opens a note's window over this page. */
export function useOpenNoteWindow(): (noteId: string) => void {
  const router = useRouter()
  return useCallback(
    (noteId: string) => {
      void router
        .navigate({
          to: '.',
          search: (prev) => ({ ...prev, modal: 'note' as const, id: noteId }),
          resetScroll: false,
        })
        .then(() => {
          pushedAt = router.state.location.state.__TSR_index
        })
    },
    [router],
  )
}

/** Closes the note's window: Back when it was opened here, else in place. */
export function useCloseNoteWindow(): () => void {
  const router = useRouter()
  return useCallback(() => {
    const here = router.state.location.state.__TSR_index
    if (pushedAt !== null && pushedAt === here) {
      pushedAt = null
      router.history.back()
      return
    }
    void router.navigate({
      to: '.',
      search: (prev) => ({ ...prev, modal: undefined, id: undefined }),
      replace: true,
      resetScroll: false,
    })
  }, [router])
}
