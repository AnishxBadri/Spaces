import { useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { DocumentPreview } from '#/components/document-preview'
import { NoteEditor } from '#/components/editor/note-editor'
import { NOTE_INSET } from '#/components/editor/note-column'
import type { GlossaryTerm } from '#/components/editor/glossary-decoration'
import { NOTE_KIND_LABEL } from '#/components/note-kind-icon'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { getNoteWindow, listTermsForNote } from '#/lib/server-fns'
import { openModalId } from '#/lib/modal-search'
import { cn } from '#/lib/utils'
import { SaveWord } from './note-head'
import type { SaveState } from './note-head'
import { noteKindEntries, useNoteKind } from './note-menu'
import { NoteMark } from './note-mark'
import { useDocumentPreview, useNoteFileDrop } from './use-note-files'
import { useNoteLeaveGuard, useNoteSave } from './use-note-save'

/**
 * A note opened over the record it was opened from (`?modal=note&id=`), so
 * reading it never loses the record behind.
 * - Head: the leading mark (a menu: Note, Memo), the serif title edited in
 *   place, and at the right the people and the day in mono, on one line.
 * - Body: the note's editor at its 72ch measure, scrolling inside the
 *   window. Its floating menus mount in the sheet, outside the scroller, so
 *   the window's focus trap and pointer guard let them be used and the
 *   scroller never clips them. A file mention opens the file viewer stepped
 *   down over the window, and a dropped file is filed on the note, as on
 *   the note's page.
 * - Foot: the save word, `Only you` for a private note, `Open as page ↗`
 *   and `Done`. It autosaves, so there is no Cancel.
 * - Done, Esc and the scrim land the last edit before the window closes; a
 *   save that fails keeps it open on `Not saved · Retry`. Back closes it at
 *   once and the last edit still lands behind it. Leaving the record waits
 *   for the last edit once the reader confirms.
 */

/** A note as its window reads it. */
export type NoteWindowData = NonNullable<
  Awaited<ReturnType<typeof getNoteWindow>>
>

/**
 * Who the head names: a meeting note's attendees, else the author, never
 * the viewer.
 */
export function noteWindowPeople(data: NoteWindowData): Array<string> {
  if (data.attendees.length > 0) return data.attendees
  return data.note.isMine ? [] : [data.note.author]
}

/** The head's right end: `Priya Raman, Dev Shah · 11 Oct`. */
export function noteWindowLine(data: NoteWindowData, today: string): string {
  const people = noteWindowPeople(data).join(', ')
  const day = formatDay(data.note.createdAt, today)
  return people === '' ? day : `${people} · ${day}`
}

/**
 * The save word as the foot prints it: an untouched note is already saved,
 * so it says `Saved` from the start.
 */
export function windowSaveState(state: SaveState): SaveState {
  return state === 'idle' ? 'saved' : state
}

/**
 * The window a record page opens from its URL. Closing drops `modal` and
 * `id`, keeps the tab, and reloads the record so its rows read the edit.
 */
export function NoteModal() {
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const router = useRouter()
  const onClose = useCallback(() => {
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, modal: undefined, id: undefined }),
      replace: true,
      resetScroll: false,
    })
    void router.invalidate()
  }, [navigate, router])
  const onOpenPage = useCallback(
    (noteId: string) =>
      void navigate({ to: '/notes/$noteId', params: { noteId } }),
    [navigate],
  )
  return (
    <NoteWindow
      id={openModalId(search, 'note')}
      onClose={onClose}
      onOpenPage={onOpenPage}
    />
  )
}

/** What the open note hands the window: its pending save, run on a close. */
type Flush = RefObject<(() => Promise<boolean>) | null>

/**
 * The window itself, open while `id` is a note's. `onClose` runs once the
 * last edit has landed; `onOpenPage` likewise, with the note's id.
 */
export function NoteWindow({
  id,
  onClose,
  onOpenPage,
}: {
  id: string | null
  onClose: () => void
  onOpenPage: (noteId: string) => void
}) {
  const flush = useRef<(() => Promise<boolean>) | null>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const leaving = useRef(false)
  const menuTookEscape = useRef(false)

  /** Lands the pending edit, then leaves; a failed save stays open. */
  const leave = useCallback(async (then: () => void) => {
    if (leaving.current) return
    leaving.current = true
    try {
      const landed = flush.current === null ? true : await flush.current()
      if (landed) then()
    } finally {
      leaving.current = false
    }
  }, [])
  const close = useCallback(() => void leave(onClose), [leave, onClose])

  return (
    <Dialog
      open={id !== null}
      onOpenChange={(open) => {
        if (open) return
        if (menuTookEscape.current) {
          menuTookEscape.current = false
          return
        }
        close()
      }}
    >
      <DialogContent
        ref={sheet}
        size="note"
        data-note-window
        aria-describedby={undefined}
        // Escape belongs to an open slash or mention menu first: the editor
        // closes its menu and the window stays. The key is left unprevented,
        // because the editor ignores a key another handler has prevented.
        onEscapeKeyDown={() => {
          menuTookEscape.current =
            sheet.current?.querySelector('.bn-suggestion-menu') != null
          queueMicrotask(() => {
            menuTookEscape.current = false
          })
        }}
        // The sheet takes focus, not its first control (the kind menu): the
        // title takes the caret itself when the note has none.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          sheet.current?.focus()
        }}
      >
        {id === null ? null : (
          <NoteWindowBody
            key={id}
            id={id}
            flush={flush}
            onDone={close}
            onOpenPage={() => void leave(() => onOpenPage(id))}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

type Loaded =
  | { state: 'loading' }
  | { state: 'gone' }
  | { state: 'failed'; message: string }
  | { state: 'open'; data: NoteWindowData; terms: Array<GlossaryTerm> }

/** Reads the note once for the window; a stale link is `gone`. */
function NoteWindowBody({
  id,
  flush,
  onDone,
  onOpenPage,
}: {
  id: string
  flush: Flush
  onDone: () => void
  onOpenPage: () => void
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })

  useEffect(() => {
    let live = true
    Promise.all([
      getNoteWindow({ data: { id } }),
      // A missing highlight is harmless; the note opens without it.
      listTermsForNote({ data: { noteId: id } }).catch(() => []),
    ])
      .then(([data, terms]) => {
        if (!live) return
        setLoaded(
          data === null ? { state: 'gone' } : { state: 'open', data, terms },
        )
      })
      .catch((err: unknown) => {
        if (live)
          setLoaded({
            state: 'failed',
            message:
              err instanceof Error ? err.message : 'Could not read the note',
          })
      })
    return () => {
      live = false
    }
  }, [id])

  if (loaded.state === 'open')
    return (
      <OpenNote
        data={loaded.data}
        terms={loaded.terms}
        flush={flush}
        onDone={onDone}
        onOpenPage={onOpenPage}
      />
    )

  return (
    <>
      <div
        data-note-window-head
        className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-bone px-4"
      >
        <DialogTitle className="sr-only">Note</DialogTitle>
      </div>
      <div
        data-note-window-state={loaded.state}
        className="flex min-h-0 flex-1 items-center justify-center px-4"
      >
        {loaded.state === 'loading' ? (
          <Twinkle size={29} />
        ) : loaded.state === 'gone' ? (
          <p className="text-ui text-graphite">
            It was deleted, or the link is wrong.
          </p>
        ) : (
          <p role="alert" className="text-ui text-destructive">
            {loaded.message}
          </p>
        )}
      </div>
      <DialogFooter data-note-window-foot className="mx-0 mt-0 mb-0">
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  )
}

function OpenNote({
  data,
  terms,
  flush,
  onDone,
  onOpenPage,
}: {
  data: NoteWindowData
  terms: Array<GlossaryTerm>
  flush: Flush
  onDone: () => void
  onOpenPage: () => void
}) {
  const { note } = data
  const { today } = useClock()
  const [title, setTitle] = useState(note.title)
  const save = useNoteSave({ noteId: note.id, initialTitle: note.title })
  const kind = useNoteKind(note.id, note.kind)
  const [portal, setPortal] = useState<HTMLDivElement | null>(null)
  const titleField = useRef<HTMLInputElement>(null)
  const preview = useDocumentPreview()
  const onFileDrop = useNoteFileDrop(note.spaces)
  useNoteLeaveGuard(save.hasPending, save.flushNow)

  const { flushNow, hasPending } = save
  useEffect(() => {
    flush.current = flushNow
    return () => {
      flush.current = null
    }
  }, [flush, flushNow])
  // Back closes the window without a word: whatever was typed still lands.
  useEffect(
    () => () => {
      if (hasPending()) void flushNow()
    },
    [flushNow, hasPending],
  )
  // A new note opens with the caret in its title.
  const untitled = note.title === ''
  useEffect(() => {
    if (untitled) titleField.current?.focus()
  }, [untitled])

  return (
    <>
      <div
        data-note-window-head
        className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-bone px-4"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-note-window-mark
              aria-label={`Kind: ${NOTE_KIND_LABEL[kind.kind]}`}
              className="focus-ring -ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-graphite hover:bg-paper hover:text-foreground"
            >
              <NoteMark kind={kind.kind} via={note.via} head />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-36">
            {noteKindEntries({
              kind: kind.kind,
              busy: kind.busy,
              onKind: (next) => void kind.change(next),
            }).map((entry) => (
              <DropdownMenuCheckboxItem
                key={entry.label}
                checked={entry.checked}
                disabled={entry.disabled === true}
                onCheckedChange={entry.onCheckedChange}
              >
                {entry.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* The title is the window's title and its name field at once. */}
        <DialogTitle asChild>
          <input
            ref={titleField}
            value={title}
            placeholder="Untitled"
            aria-label="Note title"
            onChange={(e) => {
              setTitle(e.target.value)
              save.editTitle(e.target.value)
            }}
            className="min-w-0 flex-1 truncate bg-transparent outline-none placeholder:text-graphite"
          />
        </DialogTitle>
        <span
          data-note-window-people
          className="max-w-[45%] shrink-0 truncate mono text-micro text-graphite"
        >
          {noteWindowLine(data, today)}
        </span>
      </div>

      <div
        data-note-window-body
        className="min-h-0 flex-1 overflow-y-auto bg-paper"
      >
        <div className={cn('max-w-[72ch] pt-6 pr-8 pb-8', NOTE_INSET)}>
          <div className="prose-note">
            {portal === null ? null : (
              <NoteEditor
                initialContent={note.bodyJson}
                terms={terms}
                onChange={save.edit}
                onFileDrop={onFileDrop}
                portalRoot={portal}
              />
            )}
          </div>
        </div>
      </div>

      <DialogFooter
        data-note-window-foot
        className="mx-0 mt-0 mb-0"
        note={
          <span className="flex items-center gap-3">
            <SaveWord
              state={windowSaveState(save.state)}
              onRetry={save.retry}
            />
            {note.isPrivate ? <span data-only-you>Only you</span> : null}
          </span>
        }
      >
        <Button variant="outline" onClick={onOpenPage}>
          Open as page ↗
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>

      {/* The editor's floating menus: in the sheet, outside the scroller,
          and under `.prose-note`, which is what styles them. */}
      <div ref={setPortal} data-note-window-portal className="prose-note" />

      {/* Inside the sheet, so the viewer is this window's child and steps
          down under its head. */}
      <DocumentPreview doc={preview.doc} onOpenChange={preview.onOpenChange} />
    </>
  )
}
