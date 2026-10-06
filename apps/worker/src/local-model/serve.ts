import { Effect } from 'effect'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { embedRequest } from '@spaces/db/schema'
import {
  LOCAL_EMBED_REPLY_CHANNEL,
  LOCAL_EMBED_REQUEST_CHANNEL,
} from '@spaces/core/ai/local-model'
import { listenChannel } from '../listen-channel'
import type { LocalModelHost } from './host'

/**
 * The worker's half of the local-model seam: answers web's `embed_request`
 * rows with the model it holds. (D50)
 * - A notification carries a row id; the text and the model are in the row,
 *   and so is the answer — a vector, or the error — before the id is
 *   notified back on `embed_reply`.
 * - Rows older than `EMBED_REQUEST_TTL_MS` are pruned on every LISTEN and at
 *   most once a `EMBED_REQUEST_TTL_MS` while requests arrive: web deletes its
 *   own, so these are the ones whose asker went away.
 */

export const EMBED_REQUEST_TTL_MS = 60_000

/** Its `application_name`, which names the backend in `pg_stat_activity`. */
export const EMBED_LISTENER_APPLICATION_NAME = 'spaces-worker-embed'

const notifyReply = (id: string) =>
  db.execute(sql`select pg_notify(${LOCAL_EMBED_REPLY_CHANNEL}, ${id})`)

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Answers one request; anything it cannot write is logged, never thrown. */
export const answerEmbedRequest = Effect.fn('answerEmbedRequest')(function* (
  host: LocalModelHost,
  id: string,
): Effect.fn.Return<void> {
  const asked = yield* Effect.promise(() =>
    db
      .select({ model: embedRequest.model, text: embedRequest.text })
      .from(embedRequest)
      .where(
        and(
          eq(embedRequest.id, id),
          isNull(embedRequest.embedding),
          isNull(embedRequest.error),
        ),
      ),
  ).pipe(Effect.map((rows) => rows.at(0)))
  if (asked === undefined) return
  const answer = yield* Effect.result(host.embed(asked.model, [asked.text]))
  const vector = answer._tag === 'Success' ? answer.success.at(0) : undefined
  const written = yield* Effect.promise(() =>
    db
      .update(embedRequest)
      .set(
        vector === undefined
          ? {
              error:
                answer._tag === 'Failure'
                  ? answer.failure.message
                  : 'the model returned no vector',
              answeredAt: new Date(),
            }
          : { embedding: vector, answeredAt: new Date() },
      )
      .where(eq(embedRequest.id, id))
      .returning({ id: embedRequest.id }),
  )
  // Web gave up and deleted the row: nobody is waiting for the id.
  if (written.length > 0) yield* Effect.promise(() => notifyReply(id))
})

const prune = () =>
  db
    .delete(embedRequest)
    .where(
      lt(embedRequest.createdAt, new Date(Date.now() - EMBED_REQUEST_TTL_MS)),
    )

export type EmbedRequestServerOptions = {
  readonly connectionString: string
  readonly host: LocalModelHost
  /** Defaults to the console. */
  readonly log?: (line: string) => void
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number }
}

/** Listens for requests until interrupted, reconnecting as it must. */
export const serveEmbedRequests = (
  options: EmbedRequestServerOptions,
): Effect.Effect<never> => {
  const log = options.log ?? ((line: string) => console.log(line))
  let prunedAt = 0
  const pruneNow = () => {
    prunedAt = Date.now()
    prune().catch((err: unknown) => {
      log(`[local-model] could not prune embed_request — ${messageOf(err)}`)
    })
  }
  return listenChannel({
    connectionString: options.connectionString,
    channel: LOCAL_EMBED_REQUEST_CHANNEL,
    applicationName: EMBED_LISTENER_APPLICATION_NAME,
    label: 'local-model',
    log,
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
    onListening: pruneNow,
    onPayload: (id) => {
      if (id === '') return
      Effect.runFork(
        answerEmbedRequest(options.host, id).pipe(
          Effect.catchDefect((defect) =>
            Effect.sync(() => {
              log(`[local-model] could not answer ${id} — ${messageOf(defect)}`)
            }),
          ),
        ),
      )
      if (Date.now() - prunedAt > EMBED_REQUEST_TTL_MS) pruneNow()
    },
  })
}
