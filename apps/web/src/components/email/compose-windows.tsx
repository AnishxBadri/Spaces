import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { LabelHead, LedgerRow } from '#/components/ledger-section'
import { DensityRamp } from '#/components/dither'
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
  openCompose,
  useComposeState,
} from '#/lib/email/compose'
import type { ComposeTarget, DraftState } from '#/lib/email/compose'
import {
  deleteEmailDraft,
  getEmailDraft,
  listEmailDrafts,
} from '#/lib/server-fns'
import type { DraftRecipient, DraftRow, EmailDraftMode } from '#/lib/server-fns'
import { formatWhen } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { DraftComposer, savedLine } from './draft-composer'

/**
 * The drafts list and the full composer, mounted once in the app
 * shell and opened through `openDrafts` / `openCompose`. Drafts are the
 * viewer's own; the list says so.
 */
export function ComposeWindows() {
  const { drafts, compose } = useComposeState()
  return (
    <>
      <DraftsDialog
        open={drafts}
        onOpenChange={(open) => {
          if (!open) closeCompose()
        }}
      />
      <ComposeDialog target={compose} onClose={closeCompose} />
    </>
  )
}

const MODE_LABEL: { [M in EmailDraftMode]: string } = {
  new: 'new',
  reply: 'reply',
  reply_all: 'reply all',
  forward: 'forward',
}

/** `Dana Moreau, Arjun +2`, or an em dash for nobody. */
export function recipientsLine(to: ReadonlyArray<DraftRecipient>): string {
  const first = to.at(0)
  if (first === undefined) return '—'
  const name = first.name ?? first.email
  return to.length === 1 ? name : `${name} +${String(to.length - 1)}`
}

export function DraftsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { now } = useClock()
  const [rows, setRows] = useState<Array<DraftRow> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setRows(null)
    listEmailDrafts()
      .then((r) => {
        if (live) setRows(r)
      })
      .catch(() => {
        if (live) setError('Could not read the drafts')
      })
    return () => {
      live = false
    }
  }, [open])

  async function trash(id: string) {
    setRows((prev) => (prev ?? []).filter((r) => r.id !== id))
    try {
      await deleteEmailDraft({ data: { id } })
    } catch {
      setError('Could not delete the draft')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="l">
        <DialogHeader>
          <DialogTitle>Drafts</DialogTitle>
          <DialogDescription>
            {rows === null
              ? 'only yours'
              : `${String(rows.length)} · only yours`}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-5 flex min-h-0 flex-1 flex-col overflow-y-auto px-5">
          {rows === null ? (
            error === null ? (
              <DensityRamp width={160} />
            ) : (
              <p className="text-ui text-destructive">{error}</p>
            )
          ) : rows.length === 0 ? (
            <p className="px-3 py-2 text-ui text-graphite">No drafts.</p>
          ) : (
            <section aria-label="Drafts" className="flex flex-col">
              <LabelHead label="Subject">
                <span className="w-20 shrink-0 label-caps text-graphite">
                  Mode
                </span>
                <span className="w-44 shrink-0 label-caps text-graphite">
                  To
                </span>
                <span className="w-24 shrink-0 text-right label-caps text-graphite">
                  Saved
                </span>
                <span className="w-7 shrink-0" />
              </LabelHead>
              <ol>
                {rows.map((r, i) => (
                  <LedgerRow key={r.id} last={i === rows.length - 1}>
                    <button
                      type="button"
                      data-draft={r.id}
                      onClick={() => openCompose({ draftId: r.id })}
                      className="focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-2.5 px-3 text-left hover:bg-bone"
                    >
                      <span
                        className={
                          r.subject === ''
                            ? 'min-w-0 flex-1 truncate text-body text-graphite'
                            : 'min-w-0 flex-1 truncate text-body'
                        }
                      >
                        {r.subject === '' ? '(no subject)' : r.subject}
                      </span>
                      <span className="w-20 shrink-0 mono text-micro text-graphite">
                        {MODE_LABEL[r.mode]}
                      </span>
                      <span className="w-44 shrink-0 truncate text-ui">
                        {recipientsLine(r.to)}
                      </span>
                      <span className="w-24 shrink-0 text-right mono text-micro text-graphite">
                        {formatWhen(r.updatedAt, now)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Trash ${r.subject === '' ? 'draft' : r.subject}`}
                      onClick={() => void trash(r.id)}
                      className="focus-ring flex size-7 shrink-0 items-center justify-center rounded-md text-graphite hover:bg-bone hover:text-foreground"
                    >
                      <Trash2 className="size-3.5" strokeWidth={1.75} />
                    </button>
                  </LedgerRow>
                ))}
              </ol>
            </section>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => openCompose({ draftId: null })}>
            New email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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
              <DensityRamp width={160} />
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
