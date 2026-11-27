import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import type { DroppedDocument } from '#/components/editor/note-editor'
import {
  fileAgainstForNote,
  noteDropFailure,
  noteDropFiledIn,
  UNFILED_SHELF_LABEL,
} from '#/lib/documents/note-drop'
import { uploadDocument } from '#/lib/documents/upload'
import type { UploadPhase } from '#/lib/documents/upload'

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
