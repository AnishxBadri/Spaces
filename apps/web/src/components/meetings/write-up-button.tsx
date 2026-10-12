import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { writeUpInteraction } from '#/lib/server-fns'

/**
 * Write on a past meeting with no write-up: writes one now through the
 * write-up program and lands in the editor. Idempotent, so a second press
 * opens the same note.
 */
export function WriteUpButton({ interactionId }: { interactionId: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  async function write() {
    setPending(true)
    try {
      const { noteId } = await writeUpInteraction({ data: { interactionId } })
      void router.invalidate()
      await router.navigate({ to: '/notes/$noteId', params: { noteId } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not write it up')
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
      Write
    </Button>
  )
}
