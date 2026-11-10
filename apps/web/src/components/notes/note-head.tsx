import { Link } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { formatDay, formatTime } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { NOTE_INSET } from '#/components/editor/note-column'
import { ViaMark } from '#/components/open-in'
import { RecordHeader } from '#/components/record/record-parts'
import type { getNote } from '#/lib/server-fns'

/** A note as its page loads it. */
export type NoteData = Awaited<ReturnType<typeof getNote>>

export type NoteKind = NoteData['kind']

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved'

const STAMPS: Record<NoteKind, string> = {
  note: 'Note',
  memo: 'Memo',
  scratch: 'Scratch',
}

/**
 * The note's head is a record head with a wider left edge: the editor's side
 * menu floats left of every block, so the body starts at `NOTE_INSET` and the
 * head moves with it rather than leaving the title 12px left of the prose.
 */
export const NOTE_EDGE = NOTE_INSET

/** The day and the time it was written: `13 Oct 14:02`. */
function dayAndTime(at: string, today: string): string {
  return `${formatDay(at, today)} ${formatTime(at)}`
}

/**
 * The one mono line under the title, shaped by the note's state:
 * - written here, `Anish · 13 Oct 14:02`;
 * - landed from a tool, `via Granola · Priya Raman · 13 Oct · Open in Granola ↗`;
 * - private, `■ Only you · 13 Oct 14:02`;
 * - replaced, the same line in graphite ending `→ <newer title> ›`.
 */
export function NoteMeta({ note }: { note: NoteData }) {
  const { today } = useClock()
  const replaced = note.replacedBy
  const who = replaced === null ? 'text-foreground' : undefined
  let lead: ReactNode
  if (note.via !== null) {
    lead = (
      <>
        <ViaMark via={note.via} />
        <span> · {formatDay(note.createdAt, today)}</span>
        {note.openIn === null ? null : (
          <>
            <span> · </span>
            <a
              href={note.openIn.url}
              target="_blank"
              rel="noreferrer"
              className="focus-ring text-foreground hover:underline"
            >
              Open in {note.openIn.provider} ↗
            </a>
          </>
        )}
      </>
    )
  } else if (note.isPrivate) {
    lead = (
      <>
        <span aria-hidden className={who}>
          ■{' '}
        </span>
        <span className={who}>Only you</span>
        <span> · {dayAndTime(note.createdAt, today)}</span>
      </>
    )
  } else {
    lead = (
      <>
        <span className={who}>{note.author}</span>
        <span> · {dayAndTime(note.createdAt, today)}</span>
      </>
    )
  }
  return (
    <p
      data-note-meta={
        replaced !== null
          ? 'replaced'
          : note.via !== null
            ? 'via'
            : note.isPrivate
              ? 'private'
              : 'written'
      }
      className="break-words"
    >
      {lead}
      {replaced === null ? null : (
        <>
          <span> → </span>
          <Link
            to="/notes/$noteId"
            params={{ noteId: replaced.id }}
            className="focus-ring text-foreground hover:underline"
          >
            {replaced.title} ›
          </Link>
        </>
      )}
    </p>
  )
}

/** `Saved`, `Saving…` or `Unsaved changes`; nothing before the first edit. */
export function SaveWord({ state }: { state: SaveState }) {
  return (
    <span
      data-save-word
      className="mono text-micro text-graphite"
      role="status"
      aria-live="polite"
    >
      {state === 'saving'
        ? 'Saving…'
        : state === 'saved'
          ? 'Saved'
          : state === 'dirty'
            ? 'Unsaved changes'
            : ''}
    </span>
  )
}

/**
 * The title as the head's name field: serif, and it wraps instead of
 * clipping. One line of text — a return or a pasted newline is a space.
 */
export function NoteTitleField({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // `field-sizing: content` sizes it where the browser has it; this is for
  // the ones that do not.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${String(el.scrollHeight)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder="Untitled"
      aria-label="Note title"
      onChange={(e) => onChange(e.target.value.replace(/\s*\n\s*/g, ' '))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.preventDefault()
      }}
      className="block field-sizing-content w-full resize-none overflow-hidden bg-transparent title-serif outline-none placeholder:text-graphite"
    />
  )
}

/**
 * The note's record head: the kind stamp (and an outlined `PRIVATE` beside
 * it), the title as its name field, the meta line, and at the right only the
 * save word and the `···`. The sidebar is the way back, so there is no back
 * link.
 */
export function NoteHead({
  note,
  title,
  onTitleChange,
  saveState,
  menu,
}: {
  note: NoteData
  title: string
  onTitleChange: (next: string) => void
  saveState: SaveState
  menu: ReactNode
}) {
  return (
    <RecordHeader
      className={NOTE_EDGE}
      stamp={{ kind: STAMPS[note.kind] }}
      stampAside={
        note.isPrivate ? (
          <span data-stamp="private" className="ml-2 stamp stamp-outline">
            Private
          </span>
        ) : undefined
      }
      name={title || 'Untitled'}
      nameField={<NoteTitleField value={title} onChange={onTitleChange} />}
      archived={note.replacedBy !== null}
      meta={<NoteMeta note={note} />}
      actions={
        <span className="flex items-center gap-3">
          <SaveWord state={saveState} />
          {menu}
        </span>
      }
    />
  )
}
