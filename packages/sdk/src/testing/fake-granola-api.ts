import type { JsonObject, JsonValue } from '../contract.ts'
import type { FetchLike } from './fake-drive-api.ts'

/**
 * Granola's read-only REST API, in process: a `fetch`-shaped function
 * the recorder's real HTTP code runs against — the member (`/me`), their
 * folders, a folder's notes page by page, and one note with its typed notes
 * and, when asked, its transcript.
 *
 * - Every request is recorded with its path and query: a note in a folder
 *   nobody ticked is asserted never requested by reading `requests`.
 * - A note still processing is not returned, as Granola's is not.
 * - A deleted note stays listed in its folders with `deleted_at` set.
 * - One key is accepted (`accessToken`); any other answers 401.
 */

export const GRANOLA_API = 'https://public-api.granola.ai/v1'

/** The key the fake accepts unless given another. Not a key. */
export const FAKE_GRANOLA_KEY = 'grn_fake_member_key'

/** The member the key belongs to. */
export const FAKE_GRANOLA_OWNER = 'anish@fund.example'

export type FakeGranolaFolder = { readonly id: string; readonly name: string }

export type FakeGranolaNote = {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
  /** Still being processed: Granola returns it nowhere. */
  readonly processing?: boolean
  readonly folderIds: ReadonlyArray<string>
  readonly calendarEvent: {
    readonly calendarEventId: string
    readonly start: string
    readonly end: string
  } | null
  readonly attendees: ReadonlyArray<{
    readonly email: string
    readonly name?: string
  }>
  readonly summary: string
  readonly privateNotes: string
  readonly transcript: ReadonlyArray<{
    readonly speaker: string
    readonly text: string
  }>
}

/** One request the fake received. `path` is relative to `GRANOLA_API`. */
export type GranolaApiRequest = {
  readonly method: string
  readonly url: string
  readonly path: string
  readonly query: { readonly [name: string]: string | undefined }
}

export type FakeGranolaApi = {
  readonly fetch: FetchLike
  readonly requests: ReadonlyArray<GranolaApiRequest>
  readonly accessToken: string
  readonly folders: () => ReadonlyArray<FakeGranolaFolder>
  readonly notes: () => ReadonlyArray<FakeGranolaNote>
  /** Adds or replaces a note. */
  readonly put: (note: FakeGranolaNote) => void
  /** Moves a note into exactly these folders. */
  readonly move: (noteId: string, folderIds: ReadonlyArray<string>) => void
  /** Deletes a note: it stays listed, with `deleted_at`. */
  readonly remove: (noteId: string) => void
  /** A processing note is done and is returned from now on. */
  readonly finish: (noteId: string) => void
  /** Forgets every request recorded so far. */
  readonly clearRequests: () => void
  /** The key is revoked: every later request is a 401. */
  readonly revoke: () => void
}

export type FakeGranolaApiOptions = {
  readonly folders?: ReadonlyArray<FakeGranolaFolder>
  /** `fakeGranolaSeed(now)` when absent. */
  readonly seed?: ReadonlyArray<FakeGranolaNote>
  /** The instant the default seed is laid out around; `Date.now()` when absent. */
  readonly now?: number
  readonly accessToken?: string
  /** Notes per page; 10 when absent. */
  readonly pageSize?: number
}

export const FAKE_GRANOLA_FOLDERS: ReadonlyArray<FakeGranolaFolder> = [
  { id: 'fld_deals', name: 'Deals' },
  { id: 'fld_portfolio', name: 'Portfolio' },
  { id: 'fld_personal', name: 'Personal' },
]

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const iso = (ms: number) => new Date(ms).toISOString()

/** Yesterday at `hour` UTC, counted from `now`. */
const yesterdayAt = (now: number, hour: number) => {
  const day = new Date(now - DAY)
  day.setUTCHours(hour, 0, 0, 0)
  return day.getTime()
}

/**
 * The demo member's notes, laid out around `now`: yesterday's Flent first
 * call (in Deals, on its calendar event), the Acme board prep (in Portfolio,
 * no calendar event), a 1:1 in Personal, and a Deals note still processing.
 */
export const fakeGranolaSeed = (now: number): Array<FakeGranolaNote> => {
  const flent = yesterdayAt(now, 10)
  const acme = yesterdayAt(now, 15)
  const oneOnOne = yesterdayAt(now, 17)
  return [
    {
      id: 'not_flent_first',
      title: 'Flent — first call',
      createdAt: iso(flent),
      updatedAt: iso(flent + HOUR),
      deletedAt: null,
      folderIds: ['fld_deals'],
      calendarEvent: {
        calendarEventId: 'gcal-flent-first',
        start: iso(flent),
        end: iso(flent + HOUR / 2),
      },
      attendees: [
        { email: FAKE_GRANOLA_OWNER, name: 'Anish' },
        { email: 'maya@flent.example', name: 'Maya Rao' },
      ],
      summary:
        '## Flent\n- Raising a $4M seed\n- 40% month-on-month growth\n- Send the data room by Friday',
      privateNotes: 'Strong founder. Check the churn number.',
      transcript: [
        { speaker: 'Maya Rao', text: 'We are raising four million.' },
        { speaker: 'Anish', text: 'Send the data room.' },
      ],
    },
    {
      id: 'not_acme_board',
      title: 'Acme Robotics — board prep',
      createdAt: iso(acme),
      updatedAt: iso(acme + HOUR),
      deletedAt: null,
      folderIds: ['fld_portfolio'],
      calendarEvent: null,
      attendees: [
        { email: FAKE_GRANOLA_OWNER, name: 'Anish' },
        { email: 'jane@acme-robotics.example', name: 'Jane Founder' },
      ],
      summary: '## Acme\n- Runway to Q3\n- Hire a CFO',
      privateNotes: 'Jane is tired.',
      transcript: [{ speaker: 'Jane Founder', text: 'Runway is fine.' }],
    },
    {
      id: 'not_personal_1on1',
      title: '1:1 with Sam',
      createdAt: iso(oneOnOne),
      updatedAt: iso(oneOnOne + HOUR),
      deletedAt: null,
      folderIds: ['fld_personal'],
      calendarEvent: null,
      attendees: [
        { email: FAKE_GRANOLA_OWNER, name: 'Anish' },
        { email: 'sam@fund.example', name: 'Sam' },
      ],
      summary: '## 1:1\n- Compensation review',
      privateNotes: 'Raise for Sam.',
      transcript: [],
    },
    {
      id: 'not_deals_processing',
      title: 'Ohmium — follow-up',
      createdAt: iso(now - HOUR),
      updatedAt: iso(now - HOUR),
      deletedAt: null,
      processing: true,
      folderIds: ['fld_deals'],
      calendarEvent: null,
      attendees: [{ email: 'priya@ohmium.example', name: 'Priya' }],
      summary: '',
      privateNotes: '',
      transcript: [],
    },
  ]
}

const json = (status: number, body: JsonValue): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const failure = (status: number, message: string) =>
  json(status, { error: { status, message } })

const PAGE = /^page-(\d+)$/
const NOTE = /^\/notes\/([^/]+)$/

/** A note as the list returns it: no typed notes, no transcript. */
const listed = (
  note: FakeGranolaNote,
  folders: ReadonlyArray<FakeGranolaFolder>,
): JsonObject => ({
  id: note.id,
  object: 'note',
  title: note.title,
  owner: { email: FAKE_GRANOLA_OWNER, name: 'Anish' },
  created_at: note.createdAt,
  updated_at: note.updatedAt,
  deleted_at: note.deletedAt,
  web_url: `https://notes.granola.ai/d/${note.id}`,
  calendar_event:
    note.calendarEvent === null
      ? null
      : {
          calendar_event_id: note.calendarEvent.calendarEventId,
          scheduled_start_time: note.calendarEvent.start,
          scheduled_end_time: note.calendarEvent.end,
        },
  attendees: note.attendees.map((a) => ({
    email: a.email,
    name: a.name ?? null,
  })),
  folder_membership: folders
    .filter((f) => note.folderIds.includes(f.id))
    .map((f) => ({ id: f.id, name: f.name })),
  summary_markdown: note.summary,
})

export const makeFakeGranolaApi = (
  options: FakeGranolaApiOptions = {},
): FakeGranolaApi => {
  const accessToken = options.accessToken ?? FAKE_GRANOLA_KEY
  const pageSize = options.pageSize ?? 10
  const folders = [...(options.folders ?? FAKE_GRANOLA_FOLDERS)]
  const notes = new Map<string, FakeGranolaNote>()
  const requests: Array<GranolaApiRequest> = []
  let revoked = false

  for (const note of options.seed ?? fakeGranolaSeed(options.now ?? Date.now()))
    notes.set(note.id, note)

  const held = (noteId: string) => {
    const note = notes.get(noteId)
    if (note === undefined) throw new Error(`no note ${noteId}`)
    return note
  }
  const touch = (note: FakeGranolaNote, change: Partial<FakeGranolaNote>) =>
    notes.set(note.id, {
      ...note,
      ...change,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(note.updatedAt) + 1000),
      ).toISOString(),
    })

  const returned = () =>
    [...notes.values()].filter((n) => n.processing !== true)

  const listNotes = (query: {
    readonly [name: string]: string | undefined
  }) => {
    const folderId = query.folder_id
    if (folderId === undefined)
      return failure(
        400,
        'The fake lists one folder at a time: send folder_id.',
      )
    if (!folders.some((f) => f.id === folderId))
      return failure(404, `No folder ${folderId}`)
    const matching = returned()
      .filter((n) => n.folderIds.includes(folderId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const offset =
      query.cursor === undefined
        ? 0
        : Number(PAGE.exec(query.cursor)?.[1] ?? Number.NaN)
    if (Number.isNaN(offset)) return failure(400, 'Bad cursor.')
    const page = matching.slice(offset, offset + pageSize)
    const more = offset + pageSize < matching.length
    return json(200, {
      notes: page.map((n) => listed(n, folders)),
      hasMore: more,
      cursor: more ? `page-${offset + pageSize}` : null,
    })
  }

  const fetch: FetchLike = (url, init) => {
    const parsed = new URL(url)
    const query: { [name: string]: string | undefined } = {}
    parsed.searchParams.forEach((value, name) => {
      query[name] = value
    })
    const base = `${parsed.origin}${parsed.pathname}`
    const path = base.startsWith(GRANOLA_API)
      ? base.slice(GRANOLA_API.length)
      : parsed.pathname
    requests.push({ method: init.method, url, path, query })
    if (!base.startsWith(GRANOLA_API))
      return Promise.resolve(failure(404, `${url} is not the Granola API`))
    const authorization = Object.entries(init.headers).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1]
    if (revoked || authorization !== `Bearer ${accessToken}`)
      return Promise.resolve(failure(401, 'Invalid API key'))
    if (init.method !== 'GET')
      return Promise.resolve(failure(405, 'The Granola API is read-only'))
    if (path === '/me')
      return Promise.resolve(
        json(200, { email: FAKE_GRANOLA_OWNER, name: 'Anish' }),
      )
    if (path === '/folders')
      return Promise.resolve(
        json(200, {
          folders: folders.map((f) => ({ id: f.id, name: f.name })),
        }),
      )
    if (path === '/notes') return Promise.resolve(listNotes(query))
    const noteId = NOTE.exec(path)?.[1]
    const note =
      noteId === undefined ? undefined : notes.get(decodeURIComponent(noteId))
    if (note === undefined || note.processing === true)
      return Promise.resolve(failure(404, `${path} is not served`))
    const withTranscript = (query.include ?? '')
      .split(',')
      .includes('transcript')
    return Promise.resolve(
      json(200, {
        ...listed(note, folders),
        private_notes_markdown: note.privateNotes,
        ...(withTranscript
          ? {
              transcript: note.transcript.map((t) => ({
                speaker: t.speaker,
                text: t.text,
              })),
            }
          : {}),
      }),
    )
  }

  return {
    fetch,
    requests,
    accessToken,
    folders: () => folders,
    notes: () => [...notes.values()],
    put: (note) => {
      notes.set(note.id, note)
    },
    move: (noteId, folderIds) => {
      touch(held(noteId), { folderIds: [...folderIds] })
    },
    remove: (noteId) => {
      touch(held(noteId), { deletedAt: new Date().toISOString() })
    },
    finish: (noteId) => {
      touch(held(noteId), { processing: false })
    },
    clearRequests: () => {
      requests.length = 0
    },
    revoke: () => {
      revoked = true
    },
  }
}
