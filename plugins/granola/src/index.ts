import { Effect, Redacted } from 'effect'
import {
  ConnectionRefused,
  Content,
  Http,
  JobPermanent,
  JobRateLimited,
  JobRetryable,
  Log,
  Secrets,
  definePlugin,
  responseJson,
} from '@spaces/sdk'
import type { HttpResponse, ScheduleInput, ScheduleOutput } from '@spaces/sdk'
import { manifest } from './manifest.ts'
import {
  cursorOf,
  heldOf,
  listUrl,
  listedNote,
  noteDetail,
  noteUrl,
  notesPage,
  recordedNoteOf,
  settingsOf,
} from './notes.ts'
import type { NoteDetail } from './notes.ts'

/** A folder that pages further than this is a provider bug, not a folder. */
export const MAX_PAGES = 200

/**
 * A non-200 answer as the job's outcome. 401 is a key the member revoked or
 * Granola refused: `ConnectionRefused`, which marks that member's connection
 * and is never retried.
 */
type GranolaFailure =
  JobRetryable | JobRateLimited | JobPermanent | ConnectionRefused

const refused = (
  response: HttpResponse,
): Effect.Effect<never, GranolaFailure> => {
  const { status } = response
  if (status === 401 || status === 403)
    return Effect.fail(
      new ConnectionRefused({
        reason: 'Granola refused the key: paste a new one',
      }),
    )
  if (status === 429) {
    const seconds = Number(response.headers['retry-after'] ?? '60')
    return Effect.fail(
      new JobRateLimited({
        reason: 'Granola asked to slow down',
        retryAfterMs: (Number.isFinite(seconds) ? seconds : 60) * 1000,
      }),
    )
  }
  if (status >= 500)
    return Effect.fail(
      new JobRetryable({ reason: `Granola answered ${status}` }),
    )
  return Effect.fail(new JobPermanent({ reason: `Granola answered ${status}` }))
}

/**
 * One member's sync: every note in the folders they ticked, page by page,
 * handed to `Content.logRecordedNote`; then every note handed over last run
 * that is no longer in a ticked folder, or that Granola deleted, handed back
 * as gone.
 * - A folder nobody ticked is never listed, and a note outside the ticked
 *   folders is never requested. (D78)
 * - The typed notes and the transcript are fetched only when the member
 *   opted in, and only for a note that changed since it was handed over.
 * - The host keys each note per connection, so a run cut short and re-run
 *   doubles nothing.
 */
export const sync = Effect.fn('granola.sync')(function* (
  input: ScheduleInput,
): Effect.fn.Return<
  ScheduleOutput,
  GranolaFailure,
  Secrets | Http | Content | Log
> {
  if (input.connection === undefined) {
    return yield* new JobPermanent({
      reason: "the host gave no connection: Granola runs on each member's key",
    })
  }
  const settings = settingsOf(input.connection.settings)
  const key = yield* (yield* Secrets)
    .accessToken()
    .pipe(
      Effect.mapError(
        (e) =>
          new JobPermanent({ reason: `Granola is not connected: ${e.reason}` }),
      ),
    )
  const http = yield* Http
  const content = yield* Content
  const log = yield* Log
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${Redacted.value(key)}`,
  }
  const get = (url: string): Effect.Effect<unknown, GranolaFailure> =>
    http
      .request({ method: 'GET', url, headers })
      .pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? responseJson(response, url)
            : refused(response),
        ),
      )

  const held = heldOf(input.cursor)
  const seen = new Map<string, string>()
  const deleted = new Set<string>()
  const counts = { attached: 0, born: 0, duplicate: 0, unchanged: 0, gone: 0 }
  const wantsDetail = settings.typedNotes || settings.transcript

  for (const folderId of settings.folderIds) {
    let cursor: string | undefined
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES)
        return yield* new JobPermanent({
          reason: `Granola paged past ${MAX_PAGES} pages of folder ${folderId}`,
        })
      const page = notesPage.safeParse(yield* get(listUrl(folderId, cursor)))
      if (!page.success)
        return yield* new JobPermanent({
          reason: 'Granola returned a page this plugin cannot read',
        })
      for (const item of page.data.notes) {
        const read = listedNote.safeParse(item)
        if (!read.success) continue
        const note = read.data
        if (seen.has(note.id) || deleted.has(note.id)) continue
        if (note.deleted_at !== null && note.deleted_at !== undefined) {
          deleted.add(note.id)
          continue
        }
        seen.set(note.id, note.updated_at)
        if (held.get(note.id) === note.updated_at) {
          counts.unchanged++
          continue
        }
        let detail: NoteDetail | null = null
        if (wantsDetail) {
          const parsed = noteDetail.safeParse(
            yield* get(noteUrl(note.id, settings.transcript)),
          )
          detail = parsed.success ? parsed.data : null
        }
        const recorded = recordedNoteOf(note, detail, settings)
        if (recorded === null) continue
        const result = yield* content.logRecordedNote(recorded)
        if (result.outcome !== 'removed') counts[result.outcome]++
      }
      const next = page.data.cursor
      if (!page.data.hasMore || next === null || next === undefined) break
      cursor = next
    }
  }

  // Gone: deleted in Granola, or no longer in any ticked folder.
  for (const noteId of held.keys()) {
    if (seen.has(noteId)) continue
    yield* content.logRecordedNote({
      _tag: 'recorded-note-gone',
      providerNoteId: noteId,
    })
    counts.gone++
  }
  yield* log.info('synced', { folders: settings.folderIds.length, ...counts })
  return { nextCursor: cursorOf(seen) }
})

export const jobs = { sync }

export default definePlugin({ manifest, jobs })
