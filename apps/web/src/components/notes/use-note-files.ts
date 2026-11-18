import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { DroppedDocument } from '#/components/editor/note-editor'
import {
  DOCUMENT_PREVIEW_EVENT,
  documentPreviewRequest,
} from '#/lib/editor/document-preview-event'
import {
  fileAgainstForNote,
  noteDropFailure,
  noteDropFiledIn,
  UNFILED_SHELF_LABEL,
} from '#/lib/documents/note-drop'
import { uploadDocument } from '#/lib/documents/upload'
import type { UploadPhase } from '#/lib/documents/upload'
import { getDocumentPreview } from '#/lib/server-fns'

/** One toast, rewritten in place, for the three phases of a dropped file. */
const DROP_PHASES: Record<UploadPhase, string> = {
  hashing: 'Reading…',
  uploading: 'Uploading…',
  filing: 'Filing…',
}

/**
 * A file dropped on a note's body becomes a document filed exactly where the
 * note is filed (nowhere, if the note is unfiled), and a mention chip where
 * the pointer let go. The editor owns the gesture and the insert; this owns
 * the upload and what the reader is told. The note page and the note window
 * both hand it to their editor.
 * - One `uploadDocument` call per file, carrying **every** space in one
 *   `fileAgainst` array: one document row with N edges, never N copies.
 */
export function useNoteFileDrop(
  spaces: Array<{ id: string; name: string }>,
): (file: File) => Promise<DroppedDocument | null> {
  const navigate = useNavigate()

  // Read once, for the note, not once per file: four files dropped together
  // inherit the filing the note had when they were dropped, even if a space
  // chip is removed while the third is still hashing.
  const fileAgainst = useMemo(() => fileAgainstForNote(spaces), [spaces])
  const filedIn = useMemo(() => noteDropFiledIn(spaces), [spaces])
  const unfiled = fileAgainst.length === 0

  return useCallback(
    async (file: File) => {
      // One toast per file, rewritten through the three phases and then into
      // its own outcome, so a four-file drop is four lines and not twelve.
      const id = toast.loading(`${file.name} · ${DROP_PHASES.hashing}`)
      try {
        const born = await uploadDocument({
          file,
          fileAgainst,
          onPhase: (phase) =>
            toast.loading(`${file.name} · ${DROP_PHASES[phase]}`, { id }),
        })
        if (unfiled) {
          // Not an error — unfiled is a first-class state — but not a
          // silent success either: the document is real and nobody has said
          // where it lives, so the line that says so carries the way to it.
          toast.message(filedIn, {
            id,
            description: `${file.name} is on the shelf with no filing of its own.`,
            action: {
              label: UNFILED_SHELF_LABEL,
              onClick: () =>
                void navigate({
                  to: '/files',
                  search: { filed: 'unfiled' },
                }),
            },
          })
        } else {
          toast.success(`${file.name} · ${filedIn}`, { id })
        }
        return { entityId: born.id, label: file.name }
      } catch (err) {
        // Caught per file and inside the caller's loop: one 300MB deck
        // refused by the size guard must not take the three good files after
        // it with it, and returning null is what leaves no chip behind.
        toast.error(noteDropFailure(file.name, err), { id })
        return null
      }
    },
    [fileAgainst, filedIn, navigate, unfiled],
  )
}

/**
 * The document preview a note opens on behalf of its mention chips, for the
 * caller to mount as `DocumentPreview`: the page beside its sheet, the
 * window inside its own, so the viewer steps down over it.
 * - Mounted by the note, not by the editor: a chip renders inside
 *   BlockNote's ProseMirror tree, where a Radix dialog has no context to open
 *   in and is remounted on every nearby keystroke. The chip dispatches; this
 *   listens.
 * - The chip carries only an entity id, so the row is fetched on the click
 *   rather than loaded with the note — a note may mention a dozen decks and
 *   open none of them.
 */
export function useDocumentPreview() {
  const [doc, setDoc] =
    useState<Awaited<ReturnType<typeof getDocumentPreview>>>(null)

  // A run token, not a boolean: a second chip clicked while the first fetch
  // is in flight must win, and a fetch that resolves after a close must not
  // reopen the dialog.
  const runRef = useRef(0)

  const open = useCallback((entityId: string) => {
    const run = ++runRef.current
    void (async () => {
      try {
        const row = await getDocumentPreview({ data: { id: entityId } })
        if (runRef.current !== run) return
        if (!row) {
          toast.error('That document is no longer here')
          return
        }
        setDoc(row)
      } catch (err) {
        if (runRef.current !== run) return
        toast.error(
          err instanceof Error ? err.message : 'Could not open that document',
        )
      }
    })()
  }, [])

  const onOpenChange = useCallback((next: boolean) => {
    if (next) return
    runRef.current++
    setDoc(null)
  }, [])

  useEffect(() => {
    const onRequest = (event: Event) => {
      const request = documentPreviewRequest(event)
      if (request) open(request.entityId)
    }
    // The event bubbles out of the editor to the document, which is the one
    // node guaranteed to be above every chip however BlockNote nests them.
    globalThis.document.addEventListener(DOCUMENT_PREVIEW_EVENT, onRequest)
    return () => {
      globalThis.document.removeEventListener(DOCUMENT_PREVIEW_EVENT, onRequest)
    }
  }, [open])

  return { doc, open, onOpenChange }
}
