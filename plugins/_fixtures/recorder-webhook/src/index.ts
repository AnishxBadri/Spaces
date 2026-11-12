import { Effect, Option, Schema } from 'effect'
import { Content, JobPermanent, Log, definePlugin } from '@spaces/sdk'
import type { JsonValue, RecordedNote } from '@spaces/sdk'
import { manifest } from './manifest.ts'

const invitee = Schema.Struct({
  email: Schema.NonEmptyString,
  name: Schema.optional(Schema.String),
})

/** Fathom's "new meeting content" delivery — what this fixture reads of it. */
const fathom = Schema.Struct({
  recording_id: Schema.Int,
  title: Schema.String,
  url: Schema.NonEmptyString,
  share_url: Schema.optional(Schema.NonEmptyString),
  recording_start_time: Schema.NonEmptyString,
  recording_end_time: Schema.optional(Schema.NonEmptyString),
  calendar_invitees: Schema.Array(invitee).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  default_summary: Schema.optional(
    Schema.NullOr(Schema.Struct({ markdown_formatted: Schema.String })),
  ),
})

/** tl;dv's `MeetingReady` delivery. */
const tldv = Schema.Struct({
  id: Schema.NonEmptyString,
  event: Schema.Literal('MeetingReady'),
  data: Schema.Struct({
    id: Schema.NonEmptyString,
    name: Schema.String,
    happenedAt: Schema.NonEmptyString,
    duration: Schema.optional(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
    url: Schema.NonEmptyString,
    invitees: Schema.Array(invitee).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
    notes: Schema.optional(Schema.String),
  }),
})

const plus = (iso: string, seconds: number) =>
  new Date(Date.parse(iso) + seconds * 1000).toISOString()

/**
 * The pure half: one delivery → one recorded note, keyed by the provider's
 * own id for the meeting — a replayed delivery is the same note. Null for a
 * delivery that is neither shape.
 */
export const toRecordedNote = (payload: JsonValue): RecordedNote | null => {
  const f = Schema.decodeUnknownOption(fathom)(payload)
  if (Option.isSome(f)) {
    const d = f.value
    const summary = d.default_summary?.markdown_formatted
    return {
      _tag: 'recorded-note',
      providerNoteId: `fathom:${d.recording_id}`,
      title: d.title,
      startedAt: new Date(d.recording_start_time).toISOString(),
      ...(d.recording_end_time === undefined
        ? {}
        : { endedAt: new Date(d.recording_end_time).toISOString() }),
      attendees: d.calendar_invitees.map((i) => ({
        email: i.email,
        ...(i.name === undefined ? {} : { name: i.name }),
      })),
      ...(summary === undefined ? {} : { summary }),
      webUrl: d.share_url ?? d.url,
      recordingUrl: d.url,
      raw: payload,
    }
  }
  const t = Schema.decodeUnknownOption(tldv)(payload)
  if (Option.isSome(t)) {
    const d = t.value.data
    return {
      _tag: 'recorded-note',
      providerNoteId: `tldv:${d.id}`,
      title: d.name,
      startedAt: new Date(d.happenedAt).toISOString(),
      ...(d.duration === undefined
        ? {}
        : { endedAt: plus(d.happenedAt, d.duration) }),
      attendees: d.invitees.map((i) => ({
        email: i.email,
        ...(i.name === undefined ? {} : { name: i.name }),
      })),
      ...(d.notes === undefined ? {} : { summary: d.notes }),
      webUrl: d.url,
      recordingUrl: d.url,
      raw: payload,
    }
  }
  return null
}

export default definePlugin({
  manifest,
  jobs: {
    ingest: ({ payload }) =>
      Effect.gen(function* () {
        const note = toRecordedNote(payload)
        if (note === null)
          return yield* new JobPermanent({
            reason: 'the delivery is neither a Fathom nor a tl;dv meeting',
          })
        const result = yield* (yield* Content).logRecordedNote(note)
        yield* (yield* Log).info('ingested', {
          note: note.providerNoteId,
          outcome: result.outcome,
        })
      }),
  },
})
