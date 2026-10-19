import { Effect } from 'effect'
import { z } from 'zod'
import { Content, JobPermanent, Log, definePlugin } from '@spaces/sdk'
import type { JsonValue, RecordedNote } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/** Fathom's "new meeting content" delivery — what this fixture reads of it. */
const fathom = z.object({
  recording_id: z.number().int(),
  title: z.string(),
  url: z.string().min(1),
  share_url: z.string().min(1).optional(),
  recording_start_time: z.string().min(1),
  recording_end_time: z.string().min(1).optional(),
  calendar_invitees: z
    .array(z.object({ email: z.string().min(1), name: z.string().optional() }))
    .default([]),
  default_summary: z.object({ markdown_formatted: z.string() }).nullish(),
})

/** tl;dv's `MeetingReady` delivery. */
const tldv = z.object({
  id: z.string().min(1),
  event: z.literal('MeetingReady'),
  data: z.object({
    id: z.string().min(1),
    name: z.string(),
    happenedAt: z.string().min(1),
    duration: z.number().nonnegative().optional(),
    url: z.string().min(1),
    invitees: z
      .array(
        z.object({ email: z.string().min(1), name: z.string().optional() }),
      )
      .default([]),
    notes: z.string().optional(),
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
  const f = fathom.safeParse(payload)
  if (f.success) {
    const d = f.data
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
  const t = tldv.safeParse(payload)
  if (t.success) {
    const d = t.data.data
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
