import { ClientOnly, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { DocumentPreview } from '#/components/document-preview'
import { NoteEditor } from '#/components/editor/note-editor'
import { NoteHead } from '#/components/notes/note-head'
import { NoteSheet } from '#/components/notes/note-sheet'
import { NoteMoreMenu } from '#/components/notes/note-menu'
import { NoteRail } from '#/components/notes/note-rail'
import {
  useDocumentPreview,
  useNoteFileDrop,
} from '#/components/notes/use-note-files'
import {
  useNoteLeaveGuard,
  useNoteSave,
} from '#/components/notes/use-note-save'
import {
  RecordGone,
  RecordHeadPending,
  RecordLoadFailed,
} from '#/components/record/record-parts'
import { fileInSpaceAction } from '#/lib/file-in-space'
import { loadNotePage } from '#/lib/notes/page-load'
import { usePageActions } from '#/lib/page-actions'
import { saveNoteAsNewVersion } from '#/lib/server-fns'

/**
 * The prose register: this page reads like a page, not a dashboard. A
 * record head, the body on paper at a capped measure, and the rail that says
 * where the note is filed and who may read it.
 */
export const Route = createFileRoute('/_app/notes_/$noteId')({
  loader: ({ params }) => loadNotePage(params.noteId),
  // The page holds the title and the editor in state: another note, such as
  // a new version, mounts fresh rather than inheriting them.
  remountDeps: ({ params }) => params.noteId,
  component: NotePage,
  pendingComponent: () => <RecordHeadPending kind="Note" />,
  notFoundComponent: () => (
    <RecordGone kind="Note" listTo="/notes" listLabel="Open Notes" />
  ),
  errorComponent: ({ error }) => <RecordLoadFailed kind="Note" error={error} />,
})

function NotePage() {
  const { note, allSpaces, terms } = Route.useLoaderData()
  const [title, setTitle] = useState(note.title)
  const save = useNoteSave({ noteId: note.id, initialTitle: note.title })
  const preview = useDocumentPreview()
  const onFileDrop = useNoteFileDrop(note.spaces)
  useNoteLeaveGuard(save.hasPending, save.flushNow)

  usePageActions([
    fileInSpaceAction({
      id: note.id,
      name: title || 'Untitled',
      filedIds: note.spaces.map((s) => s.id),
    }),
  ])

  return (
    <>
      <NoteSheet
        head={
          <NoteHead
            note={note}
            title={title}
            onTitleChange={(next) => {
              setTitle(next)
              save.editTitle(next)
            }}
            saveState={save.state}
            onRetry={save.retry}
            menu={
              <NoteMoreMenu
                noteId={note.id}
                title={title}
                kind={note.kind}
                saveNewVersion={async () => {
                  // The pending autosave lands first, so the copy carries
                  // the latest body; if it fails there is no copy of older
                  // text, and the save word says so.
                  if (!(await save.flushNow())) return null
                  const { id } = await saveNoteAsNewVersion({
                    data: { id: note.id },
                  })
                  return id
                }}
              />
            }
          />
        }
        editor={
          <ClientOnly fallback={<div className="min-h-40" />}>
            <NoteEditor
              initialContent={note.bodyJson}
              terms={terms}
              onChange={save.edit}
              onFileDrop={onFileDrop}
            />
          </ClientOnly>
        }
        rail={
          <NoteRail
            note={note}
            allSpaces={allSpaces}
            onPreview={preview.open}
          />
        }
      />

      {/* Mounted by the page, not by the editor: see useDocumentPreview. */}
      <DocumentPreview doc={preview.doc} onOpenChange={preview.onOpenChange} />
    </>
  )
}
