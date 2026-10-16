import { Effect } from 'effect'
import {
  JobPermanent,
  JobRateLimited,
  JobRetryable,
  Log,
  configOf,
  definePlugin,
} from '@spaces/sdk'
import type { ScheduleInput, StorageSourceError } from '@spaces/sdk'
import { boxSource } from './box.ts'
import { manifest } from './manifest.ts'

/** The most entries one run logs; a folder bigger than this is cut off with a warning. */
export const MAX_ENTRIES = 1000

/** A storage failure as the job's outcome. */
const asJobError = (error: StorageSourceError) => {
  switch (error._tag) {
    case 'NotFound':
      return new JobPermanent({
        reason: `${error.id} is not a Box folder this connection can see`,
      })
    case 'AuthExpired':
      return new JobPermanent({
        reason: `Box refused the connection: ${error.reason}`,
      })
    case 'RateLimited':
      return new JobRateLimited({
        reason: 'Box asked to slow down',
        retryAfterMs: error.retryAfterMs,
      })
    case 'CursorExpired':
      return new JobRetryable({
        reason: 'a Box folder marker expired mid-list',
      })
  }
}

/**
 * The demo job: walk the folder the row's settings name, breadth first,
 * and log every entry with its path from All Files. Reads only; one row is
 * one folder.
 */
export const list = Effect.fn('box.list')(function* (_input: ScheduleInput) {
  const { folderId } = yield* configOf(manifest)
  const log = yield* Log
  const source = yield* boxSource
  const walk = Effect.gen(function* () {
    const top = yield* source.getFolder(folderId)
    const root = [...top.parents.map((p) => p.name), top.name].join('/')
    const queue = [{ id: top.id, path: root }]
    let seen = 0
    // Breadth first; the loop visits what it appends.
    for (const folder of queue) {
      let cursor: string | undefined
      do {
        const page = yield* source.listFolder(
          folder.id,
          cursor === undefined ? {} : { cursor },
        )
        for (const entry of page.entries) {
          if (seen >= MAX_ENTRIES) {
            yield* log.warn('stopped', { folderId, entries: seen })
            return seen
          }
          seen++
          const path = `${folder.path}/${entry.name}`
          yield* log.info('entry', {
            path,
            id: entry.id,
            kind: entry.kind,
            mime: entry.mime,
            changeToken: entry.changeToken,
          })
          if (entry.kind === 'folder') queue.push({ id: entry.id, path })
        }
        cursor = page.next
      } while (cursor !== undefined)
    }
    yield* log.info('listed', { folderId, path: root, entries: seen })
    return seen
  })
  yield* walk.pipe(Effect.mapError(asJobError))
  return { nextCursor: null }
})

export const jobs = { list }

export default definePlugin({ manifest, jobs, storageSource: boxSource })
