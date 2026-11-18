import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { pendingBlob } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import {
  EXPORT_KEEP_MS,
  EXPORT_KEY,
  readExportSummary,
} from '@spaces/core/export/workspace'
import { storage } from '@spaces/core/writes/storage'
import { enqueue, jobsByKey } from '#/lib/queue'

/**
 * The workspace export's state for Settings → General, read off the queue
 * and the blob store with no table of its own:
 * - the newest `workspace.export` job says queued, running or failed;
 * - a completed job's summary names the zip's digest and size;
 * - the zip's `pending_blob` row says when it was stored, so when its day
 *   ends — the orphan sweep deletes it after that.
 * Outside `lib/server/`: the tests call these programs without a request.
 */

export type WorkspaceExport =
  | { readonly state: 'none' }
  | { readonly state: 'running' }
  | { readonly state: 'failed'; readonly reason: string }
  | {
      readonly state: 'ready'
      readonly sizeBytes: number
      /** ISO; Download is refused after it. */
      readonly expiresAt: string
    }

export class WorkspaceExportReadFailed extends Schema.TaggedError<WorkspaceExportReadFailed>()(
  'WorkspaceExportReadFailed',
  { cause: Schema.Defect() },
) {}

/** Download pressed with no zip to hand: none finished, or its day is over. */
export class WorkspaceExportGone extends Schema.TaggedError<WorkspaceExportGone>()(
  'WorkspaceExportGone',
  {},
) {}

/** The sentence a caller shows; a tagged error carries no `message`. */
export function workspaceExportMessage(failure: unknown): string {
  if (failure instanceof WorkspaceExportGone)
    return 'This export has expired; export again'
  return 'Could not read the export'
}

const io = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WorkspaceExportReadFailed({ cause }),
  })

/** The wrapper's `JobOutcome.reason`: a failure's reason, a success's summary. */
const reasonOf = (output: object | null): string | null => {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

type Held = { sha: string; sizeBytes: number; expiresAt: Date }

/** The newest job, and the zip it stored while its day lasts. */
const latestExport = Effect.fn('latestExport')(function* (now: Date) {
  const jobs = yield* io(() => jobsByKey(QUEUES.exportWorkspace, EXPORT_KEY))
  const latest = [...(jobs ?? [])]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)
  if (latest === undefined) return { latest: null, held: null }
  if (latest.state !== 'completed') return { latest, held: null }
  const stored = readExportSummary(reasonOf(latest.output) ?? '')
  if (stored === null) return { latest, held: null }
  const intent = (yield* io(() =>
    db
      .select({ preparedAt: pendingBlob.preparedAt })
      .from(pendingBlob)
      .where(eq(pendingBlob.sha, stored.sha)),
  )).at(0)
  if (intent === undefined) return { latest, held: null }
  const expiresAt = new Date(intent.preparedAt.getTime() + EXPORT_KEEP_MS)
  const held: Held | null = expiresAt > now ? { ...stored, expiresAt } : null
  return { latest, held }
})

/** What the row shows. Any member may read it; only an admin acts on it. */
export const workspaceExportProgram = Effect.fn('workspaceExportProgram')(
  function* (
    now: Date = new Date(),
  ): Effect.fn.Return<WorkspaceExport, WorkspaceExportReadFailed> {
    const { latest, held } = yield* latestExport(now)
    if (latest === null) return { state: 'none' }
    switch (latest.state) {
      case 'created':
      case 'retry':
      case 'active':
        return { state: 'running' }
      case 'failed':
      case 'cancelled':
        return {
          state: 'failed',
          reason: reasonOf(latest.output) ?? 'The export did not finish',
        }
      case 'completed':
        return held === null
          ? { state: 'none' }
          : {
              state: 'ready',
              sizeBytes: held.sizeBytes,
              expiresAt: held.expiresAt.toISOString(),
            }
    }
  },
)

/**
 * Sends the export as `requestedBy`. pg-boss refuses a second while one is
 * queued or running, so a double press is one export.
 */
export const startWorkspaceExportProgram = Effect.fn(
  'startWorkspaceExportProgram',
)(function* (
  requestedBy: string,
): Effect.fn.Return<WorkspaceExport, WorkspaceExportReadFailed> {
  yield* io(() =>
    enqueue(
      QUEUES.exportWorkspace,
      { requestedBy },
      { singletonKey: EXPORT_KEY },
    ),
  )
  return yield* workspaceExportProgram()
})

/** A short-lived signed URL for the zip, named for the day it was made. */
export const workspaceExportUrlProgram = Effect.fn('workspaceExportUrlProgram')(
  function* (
    now: Date = new Date(),
  ): Effect.fn.Return<
    { url: string },
    WorkspaceExportReadFailed | WorkspaceExportGone
  > {
    const { held } = yield* latestExport(now)
    if (held === null) return yield* new WorkspaceExportGone()
    const day = new Date(held.expiresAt.getTime() - EXPORT_KEEP_MS)
      .toISOString()
      .slice(0, 10)
    const url = yield* io(() =>
      storage().getDownloadUrl(held.sha, 300, {
        filename: `spaces-export-${day}.zip`,
      }),
    )
    return { url }
  },
)
