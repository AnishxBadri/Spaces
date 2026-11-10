import { useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { icon } from '#/components/icons'
import { SaveAsTemplateAction } from '#/components/templates'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { MENU_RULE, MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import {
  deleteNote,
  previewNoteDeletion,
  saveNoteAsTemplate,
  setNoteKind,
} from '#/lib/server-fns'
import type { NoteKind } from './note-head'

const KINDS: ReadonlyArray<{ id: NoteKind; label: string }> = [
  { id: 'note', label: 'Note' },
  { id: 'memo', label: 'Memo' },
  { id: 'scratch', label: 'Scratch' },
]

/**
 * The note head's `···`, in order: the `KIND` group of three checked rows;
 * a rule; Save as new version, Save as template…, Copy link; a rule; Delete….
 * Every verb is a callback, so the order is testable without a menu open.
 */
export function noteMenuEntries({
  kind,
  busy,
  onKind,
  onNewVersion,
  onTemplate,
  onCopyLink,
  onDelete,
}: {
  kind: NoteKind
  busy: boolean
  onKind: (next: NoteKind) => void
  onNewVersion: () => void
  onTemplate: () => void
  onCopyLink: () => void
  onDelete: () => void
}): Array<MoreMenuEntry> {
  return [
    { group: 'Kind' },
    ...KINDS.map((k) => ({
      label: k.label,
      checked: k.id === kind,
      disabled: busy,
      // Choosing the checked row again is not a change.
      onCheckedChange: () => {
        if (k.id !== kind) onKind(k.id)
      },
    })),
    MENU_RULE,
    {
      label: 'Save as new version',
      icon: <icon.new className="size-4" />,
      disabled: busy,
      onSelect: onNewVersion,
    },
    {
      label: 'Save as template…',
      icon: <icon.template className="size-4" />,
      opens: true,
      onSelect: onTemplate,
    },
    {
      label: 'Copy link',
      icon: <icon.copyLink className="size-4" />,
      onSelect: onCopyLink,
    },
    MENU_RULE,
    {
      label: 'Delete…',
      icon: <icon.delete className="size-4" />,
      destructive: true,
      opens: true,
      disabled: busy,
      onSelect: onDelete,
    },
  ]
}

/**
 * The note's `···` and the windows it opens.
 * - Kind is presentation and intent, never structure: a change moves one
 *   column and leaves every link, filing and the body where they were. Not
 *   gated on authorship — a shared note's genre is the team's reading of it.
 * - A new version is a copy filed where this note is, superseding it. The
 *   page writes it, because only the page holds the pending autosave that
 *   must land first; this opens the copy it hands back.
 * - Delete is hard, no trash. The preview runs before the confirm opens, so
 *   the confirm names what loses its edge, and a refusal (the mandate's
 *   note) is said in the window rather than by a toast after a yes.
 */
export function NoteMoreMenu({
  noteId,
  title,
  kind: initialKind,
  saveNewVersion,
}: {
  noteId: string
  title: string
  kind: NoteKind
  /** Saves the pending edit, then the copy; resolves to the copy's id. */
  saveNewVersion: () => Promise<string>
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [kind, setKind] = useState(initialKind)
  const [templating, setTemplating] = useState(false)
  const [busy, setBusy] = useState(false)

  async function changeKind(next: NoteKind) {
    if (busy) return
    const previous = kind
    // Optimistic: the row checks on the click and rolls back on a refusal.
    setKind(next)
    setBusy(true)
    try {
      await setNoteKind({ data: { id: noteId, kind: next } })
      await router.invalidate()
    } catch (e) {
      setKind(previous)
      toast.error(e instanceof Error ? e.message : 'Could not change that')
    } finally {
      setBusy(false)
    }
  }

  async function newVersion() {
    if (busy) return
    setBusy(true)
    try {
      const id = await saveNewVersion()
      toast.success('New version saved')
      await navigate({ to: '/notes/$noteId', params: { noteId: id } })
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save a new version',
      )
    } finally {
      setBusy(false)
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(window.location.href).then(
      () => toast.success('Link copied'),
      () => toast.error('Could not copy the link'),
    )
  }

  async function remove() {
    setBusy(true)
    try {
      const impact = await previewNoteDeletion({ data: { id: noteId } })
      const name = impact.title || 'Untitled'
      if (impact.blockedReason !== null) {
        // A notice, not a question: the server has already said it would
        // refuse, and why.
        await confirm({
          title: `“${name}” stays`,
          body: impact.blockedReason,
          kind: 'primary',
          keep: 'Close',
        })
        return
      }
      const ok = await confirm({
        title: `Delete “${name}”?`,
        body:
          impact.unlinks.length > 0
            ? 'The note and its text go for good. Everything listed below keeps its own row — only its link to this note goes.'
            : 'The note and its text go for good. This cannot be undone.',
        rows: impact.unlinks,
        action: 'Delete',
      })
      if (!ok) return
      await deleteNote({ data: { id: noteId } })
      // Leave first, then invalidate: this route's loader would otherwise
      // refetch a note that is no longer there.
      await navigate({ to: '/notes' })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <MoreMenu
        variant="head"
        label="this note"
        forceMenu
        items={noteMenuEntries({
          kind,
          busy,
          onKind: (next) => void changeKind(next),
          onNewVersion: () => void newVersion(),
          onTemplate: () => setTemplating(true),
          onCopyLink: copyLink,
          onDelete: () => void remove(),
        })}
      />
      <SaveAsTemplateAction
        entityLabel="note"
        defaultName={title}
        open={templating}
        onOpenChange={setTemplating}
        onSave={async (name) => {
          await saveNoteAsTemplate({ data: { noteId, name } })
        }}
      />
      {confirmDialog}
    </>
  )
}
