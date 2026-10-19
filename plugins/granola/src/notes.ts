import { z } from 'zod'
import type { JsonObject, RecordedNote } from '@spaces/sdk'

/**
 * Granola's notes, read and turned into recorded notes. Pure: no port, no
 * clock — the job decides what to fetch and where to send it.
 */

export const GRANOLA_API = 'https://public-api.granola.ai/v1'

/** Notes per page, Granola's ceiling. */
export const PAGE_SIZE = 30

/** The member's choices, as the host hands them over; nothing ticked by default. */
const settingsShape = z.object({
  folder_ids: z.array(z.string().min(1)).catch([]),
  typed_notes: z.boolean().catch(false),
  transcript: z.boolean().catch(false),
})

export type NoteSettings = {
  readonly folderIds: ReadonlyArray<string>
  readonly typedNotes: boolean
  readonly transcript: boolean
}

export const settingsOf = (settings: JsonObject): NoteSettings => {
  const parsed = settingsShape.parse(settings)
  return {
    folderIds: [...new Set(parsed.folder_ids)],
    typedNotes: parsed.typed_notes,
    transcript: parsed.transcript,
  }
}

/**
 * The cursor: every note handed over last run, with the `updated_at` it was
 * handed at. A note that is no longer in a ticked folder is the difference.
 */
const cursorShape = z.object({
  held: z.record(z.string(), z.string()),
})

export type Held = ReadonlyMap<string, string>

export const heldOf = (cursor: string | null): Held => {
  if (cursor === null) return new Map()
  try {
    const parsed = cursorShape.safeParse(JSON.parse(cursor))
    return parsed.success
      ? new Map(Object.entries(parsed.data.held))
      : new Map()
  } catch {
    return new Map()
  }
}

export const cursorOf = (held: Held): string =>
  JSON.stringify({ held: Object.fromEntries([...held].sort()) })

const attendee = z.object({
  email: z.string().nullish(),
  name: z.string().nullish(),
})

/** The fields of a listed note this plugin reads. */
export const listedNote = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullish(),
  web_url: z.string().nullish(),
  calendar_event: z
    .object({
      calendar_event_id: z.string().nullish(),
      scheduled_start_time: z.string().nullish(),
      scheduled_end_time: z.string().nullish(),
    })
    .nullish(),
  attendees: z.array(attendee).default([]),
  folder_membership: z.array(z.object({ id: z.string().min(1) })).default([]),
  summary_markdown: z.string().nullish(),
})

export type ListedNote = z.output<typeof listedNote>

/** One page of a folder's notes; items are read one by one so a bad one is skipped alone. */
export const notesPage = z.object({
  notes: z.array(z.unknown()).default([]),
  hasMore: z.boolean().default(false),
  cursor: z.string().min(1).nullish(),
})

/** The private extras, from the note itself: only fetched when opted in. */
export const noteDetail = z.object({
  private_notes_markdown: z.string().nullish(),
  transcript: z
    .array(z.object({ speaker: z.string().nullish(), text: z.string() }))
    .nullish(),
})

export type NoteDetail = z.output<typeof noteDetail>

export const listUrl = (folderId: string, cursor: string | undefined) => {
  const query = new URLSearchParams({
    folder_id: folderId,
    page_size: String(PAGE_SIZE),
  })
  if (cursor !== undefined) query.set('cursor', cursor)
  return `${GRANOLA_API}/notes?${query.toString()}`
}

export const noteUrl = (noteId: string, transcript: boolean) =>
  `${GRANOLA_API}/notes/${encodeURIComponent(noteId)}${transcript ? '?include=transcript' : ''}`

const instant = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

const present = (value: string | null | undefined): string | undefined =>
  value === null || value === undefined || value.trim() === ''
    ? undefined
    : value

/**
 * A listed note, and its extras when fetched, as the recorded note the host
 * takes. `raw` is the listed note's shared fields only: the typed notes and
 * the transcript never go into a receipt.
 */
export const recordedNoteOf = (
  note: ListedNote,
  detail: NoteDetail | null,
  settings: NoteSettings,
): RecordedNote | null => {
  const startedAt =
    instant(note.calendar_event?.scheduled_start_time) ??
    instant(note.created_at)
  if (startedAt === null) return null
  const endedAt = instant(note.calendar_event?.scheduled_end_time)
  const calendarEventId = present(note.calendar_event?.calendar_event_id)
  const title = present(note.title)
  const summary = present(note.summary_markdown)
  const webUrl = present(note.web_url)
  const typedNotes = settings.typedNotes
    ? present(detail?.private_notes_markdown)
    : undefined
  const transcript = settings.transcript
    ? present(
        (detail?.transcript ?? [])
          .map((t) => {
            const speaker = present(t.speaker)
            return speaker === undefined ? t.text : `${speaker}: ${t.text}`
          })
          .join('\n'),
      )
    : undefined
  const attendees = note.attendees.flatMap((a) => {
    const email = present(a.email)
    if (email === undefined) return []
    const name = present(a.name)
    return [{ email, ...(name === undefined ? {} : { name }) }]
  })
  const folderIds = note.folder_membership.map((f) => f.id)
  return {
    _tag: 'recorded-note',
    providerNoteId: note.id,
    startedAt,
    attendees,
    folderIds,
    ...(title === undefined ? {} : { title }),
    ...(endedAt === null || endedAt < startedAt ? {} : { endedAt }),
    ...(calendarEventId === undefined ? {} : { calendarEventId }),
    ...(summary === undefined ? {} : { summary }),
    ...(typedNotes === undefined ? {} : { typedNotes }),
    ...(transcript === undefined ? {} : { transcript }),
    ...(webUrl === undefined ? {} : { webUrl }),
    raw: {
      id: note.id,
      title: title ?? null,
      created_at: note.created_at,
      updated_at: note.updated_at,
      web_url: webUrl ?? null,
      calendar_event_id: calendarEventId ?? null,
      attendees: attendees.map((a) => a.email),
      folder_ids: folderIds,
      summary_markdown: summary ?? null,
    },
  }
}
