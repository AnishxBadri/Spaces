import { Effect, Option, Schema } from 'effect'
import type { JsonObject, RecordedNote } from '@spaces/sdk'

/**
 * Granola's notes, read and turned into recorded notes. Pure: no port, no
 * clock — the job decides what to fetch and where to send it.
 */

export const GRANOLA_API = 'https://public-api.granola.ai/v1'

/** Notes per page, Granola's ceiling. */
export const PAGE_SIZE = 30

/** `schema`, or `fallback` when the key is missing or holds anything else. */
const orElse = <
  TSchema extends Schema.Top & { readonly DecodingServices: never },
>(
  schema: TSchema,
  fallback: TSchema['Type'] & TSchema['Encoded'],
) =>
  schema.pipe(
    Schema.catchDecoding(() => Effect.succeedSome(fallback)),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  )

/** The member's choices, as the host hands them over; nothing ticked by default. */
const settingsShape = Schema.Struct({
  folder_ids: orElse(Schema.Array(Schema.NonEmptyString), []),
  typed_notes: orElse(Schema.Boolean, false),
  transcript: orElse(Schema.Boolean, false),
})

export type NoteSettings = {
  readonly folderIds: ReadonlyArray<string>
  readonly typedNotes: boolean
  readonly transcript: boolean
}

export const settingsOf = (settings: JsonObject): NoteSettings => {
  const parsed = Schema.decodeUnknownSync(settingsShape)(settings)
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
const cursorShape = Schema.Struct({
  held: Schema.Record(Schema.String, Schema.String),
})

export type Held = ReadonlyMap<string, string>

export const heldOf = (cursor: string | null): Held => {
  if (cursor === null) return new Map()
  try {
    const parsed = Schema.decodeUnknownOption(cursorShape)(JSON.parse(cursor))
    return Option.isSome(parsed)
      ? new Map(Object.entries(parsed.value.held))
      : new Map()
  } catch {
    return new Map()
  }
}

export const cursorOf = (held: Held): string =>
  JSON.stringify({ held: Object.fromEntries([...held].sort()) })

const attendee = Schema.Struct({
  email: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
})

/** The fields of a listed note this plugin reads. */
export const listedNote = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.NonEmptyString,
  updated_at: Schema.NonEmptyString,
  deleted_at: Schema.optional(Schema.NullOr(Schema.String)),
  web_url: Schema.optional(Schema.NullOr(Schema.String)),
  calendar_event: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        calendar_event_id: Schema.optional(Schema.NullOr(Schema.String)),
        scheduled_start_time: Schema.optional(Schema.NullOr(Schema.String)),
        scheduled_end_time: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  attendees: Schema.Array(attendee).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  folder_membership: Schema.Array(
    Schema.Struct({ id: Schema.NonEmptyString }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  summary_markdown: Schema.optional(Schema.NullOr(Schema.String)),
})

export type ListedNote = typeof listedNote.Type

/** One page of a folder's notes; items are read one by one so a bad one is skipped alone. */
export const notesPage = Schema.Struct({
  notes: Schema.Array(Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  hasMore: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  cursor: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
})

/** The private extras, from the note itself: only fetched when opted in. */
export const noteDetail = Schema.Struct({
  private_notes_markdown: Schema.optional(Schema.NullOr(Schema.String)),
  transcript: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          speaker: Schema.optional(Schema.NullOr(Schema.String)),
          text: Schema.String,
        }),
      ),
    ),
  ),
})

export type NoteDetail = typeof noteDetail.Type

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
