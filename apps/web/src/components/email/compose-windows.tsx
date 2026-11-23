import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Email } from '#/components/icons'
import { SplitNewButton } from '#/components/new-button'
import { TemplatePicker } from '#/components/templates'
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
  useReconnectedLanding,
  withTemplate,
} from '#/lib/email/compose'
import type { ComposeTarget, DraftHome, DraftState } from '#/lib/email/compose'
import { openComposeOf } from '#/lib/modal-search'
import { getEmailTemplate, openEmailCompose } from '#/lib/server-fns'
import { DraftComposer } from './draft-composer'

/**
 * The full composer, mounted once in the app shell and opened through
 * `openCompose`: a held draft read back, or a new email. It has no URL of
 * its own, so Reconnect Gmail comes back to the Email page's window.
 */
export function ComposeWindows() {
  const { compose } = useComposeState()
  return (
    <ComposeDialog
      target={compose}
      home="email"
      reconnected={false}
      onClose={closeCompose}
    />
  )
}

/**
 * The composer a page opens over itself from its URL (`openComposeOf`): a
 * record's Interactions tab, the Email page. A URL without the draft's id
 * gets one minted into it, so the open window is always addressable and the
 * same URL reopens the same draft, which is where Reconnect Gmail comes
 * back to. Esc or Cancel drops the keys and returns to the page as it was.
 */
export function ComposeModal({ recordId }: { recordId: string | null }) {
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const opened = openComposeOf(search)
  const draftId = opened?.draftId ?? null
  const templateId = opened?.templateId ?? null
  const minting = opened !== null && draftId === null
  const reconnected = useReconnectedLanding(draftId)

  useEffect(() => {
    if (!minting) return
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, draft: crypto.randomUUID() }),
      replace: true,
      resetScroll: false,
    })
  }, [minting, navigate])

  const target = useMemo<ComposeTarget | null>(
    () => (draftId === null ? null : { draftId, recordId, templateId }),
    [draftId, recordId, templateId],
  )

  return (
    <ComposeDialog
      target={target}
      home="here"
      reconnected={reconnected}
      onClose={() =>
        void navigate({
          to: '.',
          search: (prev) => ({
            ...prev,
            modal: undefined,
            new: undefined,
            draft: undefined,
            template: undefined,
            reconnected: undefined,
          }),
          replace: true,
          resetScroll: false,
        })
      }
    />
  )
}

/**
 * `New email ⌄`: the left half a new email, the menu the email templates,
 * each opening the composer with it applied.
 */
export function NewEmailSplit({
  onNew,
  variant,
}: {
  onNew: (templateId: string | null) => void
  /** Pine in a page head; bordered in a tab's toolbar (E6). */
  variant: 'primary' | 'secondary'
}) {
  return (
    <SplitNewButton
      noun="email"
      variant={variant}
      onNew={() => onNew(null)}
      templates={(trigger) => (
        <TemplatePicker
          kind="email"
          context="email"
          trigger={trigger}
          onPick={(t) => onNew(t.id)}
        />
      )}
    />
  )
}

type Loaded = {
  draft: DraftState
  savedAt: string | null
  /** Why its last send did not go; null for a new email. */
  notSent: string | null
  record: { id: string; name: string } | null
}

/** A held draft as it was, else a new email: To prefilled, the template applied. */
async function openTarget(target: ComposeTarget): Promise<Loaded> {
  const recordId = target.recordId ?? null
  const templateId = target.templateId ?? null
  // A bare new email asks the server nothing.
  if (target.draftId === null && recordId === null && templateId === null)
    return {
      draft: blankDraft(crypto.randomUUID()),
      savedAt: null,
      notSent: null,
      record: null,
    }
  const opening = await openEmailCompose({
    data: { draftId: target.draftId, recordId },
  })
  if (opening.draft !== null)
    return {
      draft: draftStateOf(opening.draft),
      savedAt: opening.draft.updatedAt,
      notSent: opening.draft.sendError,
      record: opening.record,
    }
  const blank = blankDraft(target.draftId ?? crypto.randomUUID(), opening.to)
  const fresh = { savedAt: null, notSent: null, record: opening.record }
  if (templateId === null) return { draft: blank, ...fresh }
  try {
    const fill = await getEmailTemplate({ data: { id: templateId } })
    return { draft: withTemplate(blank, fill), ...fresh }
  } catch (err) {
    // The email still opens, without the template.
    toast.error(err instanceof Error ? err.message : 'Could not apply it')
    return { draft: blank, ...fresh }
  }
}

/**
 * The composer's window: the mail glyph and the serif subject (or `New
 * email`) in the head; To, Subject, the body and the tool row; the foot's
 * `Saved` line, Cancel and the primary.
 */
function ComposeDialog({
  target,
  home,
  reconnected,
  onClose,
}: {
  target: ComposeTarget | null
  home: DraftHome
  /** Back from Reconnect Gmail: the draft opens on Review. */
  reconnected: boolean
  onClose: () => void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [subject, setSubject] = useState('')

  useEffect(() => {
    setLoaded(null)
    setError(null)
    setSubject('')
    if (target === null) return
    let live = true
    openTarget(target)
      .then((l) => {
        if (!live) return
        setLoaded(l)
        setSubject(l.draft.subject)
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
    subject.trim() !== ''
      ? subject
      : loaded === null || loaded.draft.mode === 'new'
        ? 'New email'
        : 'Reply'

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent size="l" data-compose-window className="h-170">
        <DialogHeader className="items-center">
          <Email aria-hidden className="size-5 shrink-0 text-graphite" />
          <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          {loaded?.draft.mode === 'new' || loaded === null
            ? 'A new email'
            : 'A draft reply'}
        </DialogDescription>
        {loaded === null ? (
          <>
            {error === null ? (
              <div className="flex min-h-48 flex-1 items-center justify-center">
                <Twinkle size={29} />
              </div>
            ) : (
              <p className="flex-1 text-ui text-destructive">{error}</p>
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
            notSent={loaded.notSent}
            home={home}
            reconnected={reconnected}
            recordId={loaded.record?.id ?? null}
            recordName={loaded.record?.name ?? null}
            onSubject={setSubject}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
