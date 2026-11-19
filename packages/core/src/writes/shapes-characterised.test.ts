import { Result, SchemaParser } from 'effect'
import type { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { keyedFolders, keyedOwner } from './connections/keyed'
import { parkedRow } from './enrichment/parked'
import { storedManifest } from './plugins/install'
import {
  emailClaim,
  readInteractionShape,
  readMeetingClaim,
  readRecordedNote,
} from './ports/content'
import { credentialInput } from './vault/index'

/**
 * The write half's runtime shapes at their edges: a bundle's claims, the
 * vault's input, a provider's answers and pg's rows. Every row was held
 * against the zod shapes before they were Effect schemas, so a row that
 * moves is a caller who sees a different answer.
 */

const REFUSED = 'REFUSED'

/** The schema's output for `input`, or `REFUSED`. */
const decoded = (schema: Schema.Decoder<unknown>, input: unknown): unknown => {
  const r = SchemaParser.decodeUnknownResult(schema)(input)
  return Result.isSuccess(r) ? r.success : REFUSED
}

/** `fn` called with what a bundle could send, typed or not. */
const call = (fn: (input: never) => unknown, input: unknown): unknown =>
  Reflect.apply(fn, undefined, [input])

/** A reader's answer: what it hands on, or `REFUSED` with its reason dropped. */
const read = (out: unknown): unknown =>
  typeof out === 'object' &&
  out !== null &&
  'ok' in out &&
  out.ok === false &&
  'reason' in out &&
  typeof out.reason === 'string'
    ? REFUSED
    : out

type Row = readonly [label: string, input: unknown, out: unknown]

const table = (name: string, run: (input: unknown) => unknown) =>
  function rows(list: ReadonlyArray<Row>) {
    describe(name, () => {
      it.each(list)('%s', (_, input, out) => {
        expect(run(input)).toEqual(out)
      })
    })
  }

const U = 'a3bb189e-8bf9-4888-9912-ace4e6543002'

const email = {
  providerMessageId: ' m-1 ',
  raw: 'aGVsbG8',
  receivedAt: '2026-10-12T10:00:00Z',
  labels: [' INBOX ', ''],
  snippet: ' hi ',
}
const emailOut = {
  providerMessageId: 'm-1',
  raw: 'aGVsbG8',
  receivedAt: '2026-10-12T10:00:00Z',
  labels: ['INBOX', ''],
  snippet: 'hi',
}

table('emailClaim', (input) => decoded(emailClaim, input))([
  ['a claim, trimmed', email, emailOut],
  [
    'no snippet',
    { ...email, snippet: undefined },
    { ...emailOut, snippet: undefined },
  ],
  ['a stray key', { ...email, _tag: 'email' }, emailOut],
  ['padded base64url', { ...email, raw: 'aGk=' }, { ...emailOut, raw: 'aGk=' }],
  ['base64 with a plus', { ...email, raw: 'a+b' }, REFUSED],
  ['three pad characters', { ...email, raw: 'a===' }, REFUSED],
  ['an empty raw', { ...email, raw: '' }, REFUSED],
  ['a blank id', { ...email, providerMessageId: '   ' }, REFUSED],
  [
    'a 512-character id',
    { ...email, providerMessageId: 'm'.repeat(512) },
    { ...emailOut, providerMessageId: 'm'.repeat(512) },
  ],
  [
    'a 513-character id',
    { ...email, providerMessageId: 'm'.repeat(513) },
    REFUSED,
  ],
  [
    'an offset',
    { ...email, receivedAt: '2026-10-12T10:00:00+05:30' },
    { ...emailOut, receivedAt: '2026-10-12T10:00:00+05:30' },
  ],
  [
    'no seconds',
    { ...email, receivedAt: '2026-10-12T10:00Z' },
    { ...emailOut, receivedAt: '2026-10-12T10:00Z' },
  ],
  [
    'a fraction',
    { ...email, receivedAt: '2026-10-12T10:00:00.123456Z' },
    { ...emailOut, receivedAt: '2026-10-12T10:00:00.123456Z' },
  ],
  [
    'a leap day',
    { ...email, receivedAt: '2024-02-29T00:00:00Z' },
    { ...emailOut, receivedAt: '2024-02-29T00:00:00Z' },
  ],
  ['not a leap day', { ...email, receivedAt: '2023-02-29T00:00:00Z' }, REFUSED],
  ['no zone', { ...email, receivedAt: '2026-10-12T10:00:00' }, REFUSED],
  [
    'a lower-case zone',
    { ...email, receivedAt: '2026-10-12T10:00:00z' },
    REFUSED,
  ],
  [
    'an offset without a colon',
    { ...email, receivedAt: '2026-10-12T10:00:00+0530' },
    REFUSED,
  ],
  ['a date alone', { ...email, receivedAt: '2026-10-12' }, REFUSED],
  ['words', { ...email, receivedAt: 'yesterday' }, REFUSED],
  [
    '201 labels',
    { ...email, labels: Array.from({ length: 201 }, () => 'L') },
    REFUSED,
  ],
  [
    'a 256-character label, padded',
    { ...email, labels: [` ${'l'.repeat(256)} `] },
    { ...emailOut, labels: ['l'.repeat(256)] },
  ],
  ['a 257-character label', { ...email, labels: ['l'.repeat(257)] }, REFUSED],
  ['no labels', { ...email, labels: undefined }, REFUSED],
  [
    'a 1001-character snippet',
    { ...email, snippet: 's'.repeat(1001) },
    REFUSED,
  ],
  ['null', null, REFUSED],
])

const attendee = {
  email: ' Ann@Acme.example ',
  name: ' Ann ',
  rsvp: 'accepted',
  self: true,
}
const meeting = {
  _tag: 'meeting',
  uid: ' uid-1 ',
  eventId: 'ev-1',
  status: 'scheduled',
  startsAt: '2026-10-12T10:00:00Z',
  endsAt: '2026-10-12T11:00:00Z',
  subject: ' Intro ',
  organizer: 'Bob@Acme.example',
  conferenceUrl: 'https://meet.example/x',
  recurringInstanceId: 'r-1',
  attendees: [attendee],
}
const meetingOut = {
  _tag: 'meeting',
  uid: 'uid-1',
  eventId: 'ev-1',
  status: 'scheduled',
  startsAt: new Date('2026-10-12T10:00:00Z'),
  endsAt: new Date('2026-10-12T11:00:00Z'),
  subject: 'Intro',
  organizer: 'bob@acme.example',
  conferenceUrl: 'https://meet.example/x',
  recurringInstanceId: 'r-1',
  attendees: [
    { email: 'ann@acme.example', name: 'Ann', rsvp: 'accepted', self: true },
  ],
}

table('readMeetingClaim', (input) => read(call(readMeetingClaim, input)))([
  ['a meeting', meeting, { ok: true, input: meetingOut }],
  [
    'the bare minimum',
    {
      ...meeting,
      subject: undefined,
      organizer: undefined,
      conferenceUrl: undefined,
      recurringInstanceId: undefined,
      attendees: [],
    },
    {
      ok: true,
      input: {
        ...meetingOut,
        subject: null,
        organizer: null,
        conferenceUrl: null,
        recurringInstanceId: null,
        attendees: [],
      },
    },
  ],
  [
    'a blank subject',
    { ...meeting, subject: '   ' },
    { ok: true, input: { ...meetingOut, subject: null } },
  ],
  [
    'an attendee with no name or self',
    { ...meeting, attendees: [{ email: 'a@b.co', rsvp: 'needs_action' }] },
    {
      ok: true,
      input: {
        ...meetingOut,
        attendees: [
          { email: 'a@b.co', name: null, rsvp: 'needs_action', self: false },
        ],
      },
    },
  ],
  [
    'a date-only start',
    { ...meeting, startsAt: '2026-10-12', endsAt: '2026-10-13' },
    {
      ok: true,
      input: {
        ...meetingOut,
        startsAt: new Date('2026-10-12'),
        endsAt: new Date('2026-10-13'),
      },
    },
  ],
  [
    'an end before its start',
    { ...meeting, endsAt: '2026-10-12T09:00:00Z' },
    REFUSED,
  ],
  ['an unreadable start', { ...meeting, startsAt: 'soon' }, REFUSED],
  ['a numeric start', { ...meeting, startsAt: 1_760_000_000_000 }, REFUSED],
  ['a stray key', { ...meeting, location: 'HQ' }, REFUSED],
  [
    'a stray attendee key',
    { ...meeting, attendees: [{ ...attendee, role: 'chair' }] },
    REFUSED,
  ],
  [
    'an unknown rsvp',
    { ...meeting, attendees: [{ ...attendee, rsvp: 'maybe' }] },
    REFUSED,
  ],
  ['a blank uid', { ...meeting, uid: '  ' }, REFUSED],
  ['a blank organizer', { ...meeting, organizer: ' ' }, REFUSED],
  ['an unknown status', { ...meeting, status: 'moved' }, REFUSED],
  [
    'a 2001-character subject',
    { ...meeting, subject: 's'.repeat(2001) },
    REFUSED,
  ],
  [
    '1001 attendees',
    { ...meeting, attendees: Array.from({ length: 1001 }, () => attendee) },
    REFUSED,
  ],
  ['no attendees', { ...meeting, attendees: undefined }, REFUSED],
  [
    'a cancellation',
    { _tag: 'meeting-cancelled', eventId: ' ev-1 ', uid: ' u ' },
    {
      ok: true,
      input: { _tag: 'meeting-cancelled', eventId: 'ev-1', uid: 'u' },
    },
  ],
  [
    'a cancellation with no uid',
    { _tag: 'meeting-cancelled', eventId: 'ev-1' },
    {
      ok: true,
      input: { _tag: 'meeting-cancelled', eventId: 'ev-1', uid: null },
    },
  ],
  [
    'a cancellation with a stray key',
    { _tag: 'meeting-cancelled', eventId: 'ev-1', status: 'cancelled' },
    REFUSED,
  ],
  ['an unknown tag', { ...meeting, _tag: 'call' }, REFUSED],
  ['no tag', { eventId: 'ev-1' }, REFUSED],
])

const recorder = {
  providerEventId: ' rec-1 ',
  icalUid: 'uid-1',
  calendarEventId: 'cal-1',
  durationSeconds: 60,
  raw: { id: 'rec-1', list: [1, 'a', null, true] },
  artifacts: [
    { role: 'recording_link', url: ' https://rec.example/1 ', title: ' Call ' },
    { role: 'transcript', documentId: U },
  ],
}
const recorderOut = {
  providerEventId: 'rec-1',
  icalUid: 'uid-1',
  calendarEventId: 'cal-1',
  durationSeconds: 60,
  raw: { id: 'rec-1', list: [1, 'a', null, true] },
  artifacts: [
    { role: 'recording_link', url: 'https://rec.example/1', title: 'Call' },
    { role: 'transcript', documentId: U },
  ],
}
const interaction = {
  _tag: 'interaction',
  kind: 'call',
  occurredAt: '2026-10-08T10:00:00Z',
  participants: [
    { email: ' Jane@Acme.example ', name: ' Jane ' },
    { email: 'jane@acme.example' },
  ],
}
// The later of two rows for one address wins, so the nameless one does.
const jane = { email: 'jane@acme.example', name: null }
const withRecorder = (r: unknown) => ({ ...interaction, recorder: r })

table('readInteractionShape', (input) =>
  read(call(readInteractionShape, input)),
)([
  [
    'participants, deduplicated',
    interaction,
    { ok: true, participants: [jane], recorder: null },
  ],
  [
    'entities and no participants',
    { ...interaction, participants: undefined, entityIds: [U] },
    { ok: true, participants: [], recorder: null },
  ],
  ['nowhere to live', { ...interaction, participants: [] }, REFUSED],
  [
    'a stray participant key',
    { ...interaction, participants: [{ email: 'a@b.co', role: 'x' }] },
    REFUSED,
  ],
  [
    'a blank participant email',
    { ...interaction, participants: [{ email: ' ' }] },
    REFUSED,
  ],
  [
    'a 401-character name',
    {
      ...interaction,
      participants: [{ email: 'a@b.co', name: 'n'.repeat(401) }],
    },
    REFUSED,
  ],
  [
    '1001 participants',
    {
      ...interaction,
      participants: Array.from({ length: 1001 }, () => ({ email: 'a@b.co' })),
    },
    REFUSED,
  ],
  [
    'participants as a string',
    { ...interaction, participants: 'a@b.co' },
    REFUSED,
  ],
  [
    'a recorder',
    withRecorder(recorder),
    { ok: true, participants: [jane], recorder: recorderOut },
  ],
  [
    'a bare recorder',
    withRecorder({ providerEventId: 'rec-1', raw: null }),
    {
      ok: true,
      participants: [jane],
      recorder: {
        providerEventId: 'rec-1',
        icalUid: null,
        calendarEventId: null,
        durationSeconds: null,
        raw: null,
        artifacts: [],
      },
    },
  ],
  [
    'an untitled recording',
    withRecorder({
      ...recorder,
      artifacts: [{ role: 'recording_link', url: 'HTTP://REC.example/1' }],
    }),
    {
      ok: true,
      participants: [jane],
      recorder: {
        ...recorderOut,
        artifacts: [
          {
            role: 'recording_link',
            url: 'HTTP://REC.example/1',
            title: 'Recording',
          },
        ],
      },
    },
  ],
  [
    'a body beside a recorder',
    { ...withRecorder(recorder), body: 'x' },
    REFUSED,
  ],
  ['a stray recorder key', withRecorder({ ...recorder, notes: 'x' }), REFUSED],
  ['no raw', withRecorder({ ...recorder, raw: undefined }), REFUSED],
  [
    'a raw infinity',
    withRecorder({ ...recorder, raw: { n: Infinity } }),
    REFUSED,
  ],
  [
    'a raw date',
    withRecorder({ ...recorder, raw: { at: new Date(0) } }),
    REFUSED,
  ],
  [
    'a fractional duration',
    withRecorder({ ...recorder, durationSeconds: 1.5 }),
    REFUSED,
  ],
  [
    'a negative duration',
    withRecorder({ ...recorder, durationSeconds: -1 }),
    REFUSED,
  ],
  [
    'a zero duration',
    withRecorder({ ...recorder, durationSeconds: 0 }),
    {
      ok: true,
      participants: [jane],
      recorder: { ...recorderOut, durationSeconds: 0 },
    },
  ],
  [
    'a blank event id',
    withRecorder({ ...recorder, providerEventId: ' ' }),
    REFUSED,
  ],
  [
    'an ftp recording',
    withRecorder({
      ...recorder,
      artifacts: [{ role: 'recording_link', url: 'ftp://rec.example/1' }],
    }),
    REFUSED,
  ],
  [
    'a recording without slashes',
    withRecorder({
      ...recorder,
      artifacts: [{ role: 'recording_link', url: 'https:rec.example/1' }],
    }),
    REFUSED,
  ],
  [
    'a recording that is not a url',
    withRecorder({
      ...recorder,
      artifacts: [{ role: 'recording_link', url: 'https://' }],
    }),
    REFUSED,
  ],
  [
    'a 2001-character recording url',
    withRecorder({
      ...recorder,
      artifacts: [
        {
          role: 'recording_link',
          url: `https://r.example/${'x'.repeat(1983)}`,
        },
      ],
    }),
    REFUSED,
  ],
  [
    'a 2000-character recording url',
    withRecorder({
      ...recorder,
      artifacts: [
        {
          role: 'recording_link',
          url: `https://r.example/${'x'.repeat(1982)}`,
        },
      ],
    }),
    {
      ok: true,
      participants: [jane],
      recorder: {
        ...recorderOut,
        artifacts: [
          {
            role: 'recording_link',
            url: `https://r.example/${'x'.repeat(1982)}`,
            title: 'Recording',
          },
        ],
      },
    },
  ],
  [
    'a transcript with a url',
    withRecorder({
      ...recorder,
      artifacts: [
        { role: 'transcript', documentId: U, url: 'https://x.example' },
      ],
    }),
    REFUSED,
  ],
  [
    'an attachment with a bad id',
    withRecorder({
      ...recorder,
      artifacts: [{ role: 'attachment', documentId: 'x' }],
    }),
    REFUSED,
  ],
  [
    'an unknown role',
    withRecorder({
      ...recorder,
      artifacts: [{ role: 'video', documentId: U }],
    }),
    REFUSED,
  ],
  [
    '51 artifacts',
    withRecorder({
      ...recorder,
      artifacts: Array.from({ length: 51 }, () => ({
        role: 'attachment',
        documentId: U,
      })),
    }),
    REFUSED,
  ],
])

const note = {
  _tag: 'recorded-note',
  providerNoteId: ' n-1 ',
  title: ' Intro call ',
  startedAt: '2026-10-08T10:00:00Z',
  endedAt: '2026-10-08T10:30:00Z',
  attendees: [{ email: ' Jane@Acme.example ', name: 'Jane' }],
  calendarEventId: 'cal-1',
  icalUid: 'uid-1',
  summary: 'Summary',
  typedNotes: '  ',
  transcript: 'Transcript',
  webUrl: ' https://notes.example/n-1 ',
  recordingUrl: 'https://notes.example/n-1/rec',
  folderIds: ['f-1'],
  raw: { id: 'n-1' },
}
const noteOut = {
  ok: true,
  gone: null,
  participants: [{ email: 'jane@acme.example', name: 'Jane' }],
  input: {
    providerNoteId: 'n-1',
    title: 'Intro call',
    startedAt: new Date('2026-10-08T10:00:00Z'),
    durationSeconds: 1800,
    emails: ['jane@acme.example'],
    calendarEventId: 'cal-1',
    icalUid: 'uid-1',
    summary: 'Summary',
    typedNotes: null,
    transcript: 'Transcript',
    webUrl: 'https://notes.example/n-1',
    recordingUrl: 'https://notes.example/n-1/rec',
    raw: { id: 'n-1' },
  },
}

table('readRecordedNote', (input) => read(call(readRecordedNote, input)))([
  ['a note', note, noteOut],
  [
    'a bare note',
    {
      _tag: 'recorded-note',
      providerNoteId: 'n-1',
      startedAt: '2026-10-08T10:00:00Z',
      attendees: [],
      raw: null,
    },
    {
      ok: true,
      gone: null,
      participants: [],
      input: {
        providerNoteId: 'n-1',
        title: null,
        startedAt: new Date('2026-10-08T10:00:00Z'),
        durationSeconds: null,
        emails: [],
        calendarEventId: null,
        icalUid: null,
        summary: null,
        typedNotes: null,
        transcript: null,
        webUrl: null,
        recordingUrl: null,
        raw: null,
      },
    },
  ],
  [
    'a deleted note',
    { ...note, deletedAt: '2026-10-09T00:00:00Z' },
    { ok: true, gone: 'n-1' },
  ],
  [
    'a gone note',
    { _tag: 'recorded-note-gone', providerNoteId: ' n-2 ' },
    { ok: true, gone: 'n-2' },
  ],
  [
    'a gone note with a stray key',
    { _tag: 'recorded-note-gone', providerNoteId: 'n-2', at: 1 },
    REFUSED,
  ],
  [
    'an end before its start',
    { ...note, endedAt: '2026-10-08T09:00:00Z' },
    REFUSED,
  ],
  ['an unreadable deletion', { ...note, deletedAt: 'never' }, REFUSED],
  ['a stray key', { ...note, owner: 'x' }, REFUSED],
  ['no raw', { ...note, raw: undefined }, REFUSED],
  ['a mailto web url', { ...note, webUrl: 'mailto:a@b.co' }, REFUSED],
  [
    '1001 folders',
    { ...note, folderIds: Array.from({ length: 1001 }, () => 'f') },
    REFUSED,
  ],
  ['a blank folder', { ...note, folderIds: [' '] }, REFUSED],
  [
    'a 1,000,001-character transcript',
    { ...note, transcript: 't'.repeat(1_000_001) },
    REFUSED,
  ],
  ['no attendees', { ...note, attendees: undefined }, REFUSED],
  ['an unknown tag', { ...note, _tag: 'note' }, REFUSED],
])

const credential = {
  scope: 'workspace',
  provider: 'openai',
  kind: 'llm',
  secret: 'sk-1',
  createdBy: 'u-1',
}

table('credentialInput', (input) => decoded(credentialInput, input))([
  ['a workspace key', credential, credential],
  [
    'a member key',
    { ...credential, scope: 'user', userId: 'u-2' },
    { ...credential, scope: 'user', userId: 'u-2' },
  ],
  ['a stray key', { ...credential, status: 'active' }, credential],
  ['an empty secret', { ...credential, secret: '' }, REFUSED],
  [
    'keyless and empty',
    { ...credential, secret: '', keyless: true },
    { ...credential, secret: '', keyless: true },
  ],
  ['keyless with a secret', { ...credential, keyless: true }, REFUSED],
  ['keyless false', { ...credential, keyless: false }, REFUSED],
  [
    'a 4000-character secret',
    { ...credential, secret: 's'.repeat(4000) },
    { ...credential, secret: 's'.repeat(4000) },
  ],
  [
    'a 4001-character secret',
    { ...credential, secret: 's'.repeat(4001) },
    REFUSED,
  ],
  ['an unknown kind', { ...credential, kind: 'oauth' }, REFUSED],
  ['an unknown scope', { ...credential, scope: 'team' }, REFUSED],
  ['an empty provider', { ...credential, provider: '' }, REFUSED],
  ['an empty author', { ...credential, createdBy: '' }, REFUSED],
  ['a numeric user', { ...credential, userId: 5 }, REFUSED],
  [
    'meta',
    {
      ...credential,
      meta: {
        baseURL: 'https://x',
        headers: { a: 'b' },
        n: 1,
        on: [true, null],
      },
    },
    {
      ...credential,
      meta: {
        baseURL: 'https://x',
        headers: { a: 'b' },
        n: 1,
        on: [true, null],
      },
    },
  ],
  ['meta with infinity', { ...credential, meta: { n: Infinity } }, REFUSED],
  ['meta as a list', { ...credential, meta: [] }, REFUSED],
  ['meta as a date', { ...credential, meta: new Date(0) }, REFUSED],
  [
    'meta with a date inside',
    { ...credential, meta: { at: new Date(0) } },
    REFUSED,
  ],
  [
    'meta with a __proto__ key',
    { ...credential, meta: JSON.parse('{"__proto__":{"x":1},"a":1}') },
    { ...credential, meta: { a: 1 } },
  ],
  ['null', null, REFUSED],
])

table('keyedOwner', (input) => decoded(keyedOwner, input))([
  [
    'an account',
    { email: 'Ann@Acme.example', name: 'Ann' },
    { email: 'Ann@Acme.example' },
  ],
  ['no address', { name: 'Ann' }, REFUSED],
  ['not an address', { email: 'ann' }, REFUSED],
  ['a padded address', { email: ' ann@acme.example' }, REFUSED],
  ['a list', [], REFUSED],
])

table('keyedFolders', (input) => decoded(keyedFolders, input))([
  [
    'folders',
    { folders: [{ id: 'f-1', name: 'Deals', shared: true }], next: null },
    { folders: [{ id: 'f-1', name: 'Deals' }] },
  ],
  ['no folders', { folders: [] }, { folders: [] }],
  [
    'an empty name',
    { folders: [{ id: 'f-1', name: '' }] },
    { folders: [{ id: 'f-1', name: '' }] },
  ],
  ['an empty id', { folders: [{ id: '', name: 'x' }] }, REFUSED],
  ['no name', { folders: [{ id: 'f-1' }] }, REFUSED],
  ['no list', {}, REFUSED],
])

const parked = {
  integration_id: 'i-1',
  source: 'Apollo',
  waiting: '14',
  resumes_ms: 1_760_000_000_000,
}

table('parkedRow', (input) => decoded(parkedRow, input))([
  ['a row', parked, { ...parked, waiting: 14 }],
  [
    'numbers as text',
    { ...parked, resumes_ms: '1760000000000.5' },
    { ...parked, waiting: 14, resumes_ms: 1_760_000_000_000.5 },
  ],
  ['an empty count', { ...parked, waiting: '' }, { ...parked, waiting: 0 }],
  ['a null count', { ...parked, waiting: null }, { ...parked, waiting: 0 }],
  ['a true count', { ...parked, waiting: true }, { ...parked, waiting: 1 }],
  ['a count that is not a number', { ...parked, waiting: 'x' }, REFUSED],
  ['an infinite instant', { ...parked, resumes_ms: 'Infinity' }, REFUSED],
  ['no source', { ...parked, source: null }, REFUSED],
  ['a stray column', { ...parked, extra: 1 }, { ...parked, waiting: 14 }],
])

table('storedManifest', (input) => decoded(storedManifest, input))([
  [
    'a manifest',
    {
      id: 'echo',
      version: 1,
      jobs: { a: { uses: ['Ai'] } },
      on: true,
      none: null,
    },
    {
      id: 'echo',
      version: 1,
      jobs: { a: { uses: ['Ai'] } },
      on: true,
      none: null,
    },
  ],
  ['empty', {}, {}],
  ['a list', [], REFUSED],
  ['a string', 'x', REFUSED],
  ['an infinity inside', { n: Infinity }, REFUSED],
  ['an undefined inside', { n: undefined }, REFUSED],
  [
    'a __proto__ key',
    JSON.parse('{"__proto__":{"x":1},"id":"echo"}'),
    { id: 'echo' },
  ],
])
