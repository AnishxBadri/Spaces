import { useEffect, useState } from 'react'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  blankDraft,
  closeCompose,
  draftStateOf,
  useComposeState,
} from '#/lib/email/compose'
import type { ComposeTarget, DraftState } from '#/lib/email/compose'
import { getEmailDraft } from '#/lib/server-fns'
import { DraftComposer, savedLine } from './draft-composer'

/**
 * The full composer, mounted once in the app shell and opened through
 * `openCompose`: a held draft read back, or a new email.
 */
export function ComposeWindows() {
  const { compose } = useComposeState()
  return <ComposeDialog target={compose} onClose={closeCompose} />
}

type Loaded = { draft: DraftState; savedAt: string | null }

/** The full composer: a held draft read back, or a new email under a fresh id. */
function ComposeDialog({
  target,
  onClose,
}: {
  target: ComposeTarget | null
  onClose: () => void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  useEffect(() => {
    setLoaded(null)
    setError(null)
    setSavedAt(null)
    if (target === null) return
    if (target.draftId === null) {
      setLoaded({ draft: blankDraft(crypto.randomUUID()), savedAt: null })
      return
    }
    let live = true
    getEmailDraft({ data: { id: target.draftId } })
      .then((d) => {
        if (!live) return
        setLoaded({ draft: draftStateOf(d), savedAt: d.updatedAt })
        setSavedAt(d.updatedAt)
      })
      .catch((err: unknown) => {
        if (live)
          setError(err instanceof Error ? err.message : 'Could not open it')
      })
    return () => {
      live = false
    }
  }, [target])

  const title =
    loaded === null || loaded.draft.mode === 'new'
      ? 'New email'
      : loaded.draft.subject || 'Reply'
  const saved = savedLine(savedAt)

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent size="l">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={saved === null ? 'sr-only' : ''}>
            {saved ?? 'A new email'}
          </DialogDescription>
        </DialogHeader>
        {loaded === null ? (
          <>
            {error === null ? (
              <div className="flex min-h-48 flex-1 items-center justify-center">
                <Twinkle size={29} />
              </div>
            ) : (
              <p className="text-ui text-destructive">{error}</p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : (
          <DraftComposer
            key={loaded.draft.id}
            initial={loaded.draft}
            savedAt={loaded.savedAt}
            onSaved={setSavedAt}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
