import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { inArray, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { db } from '@spaces/db'
import { embedRequest } from '@spaces/db/schema'
import {
  LOCAL_EMBED_REPLY_CHANNEL,
  LOCAL_EMBED_REQUEST_CHANNEL,
} from '@spaces/core/ai/local-model'
import { requireEnv } from '#/lib/server/env'

/**
 * Web's half of the local-model seam: an embedding asked of the worker over
 * Postgres `LISTEN`/`NOTIFY`. (D50)
 * - One `embed_request` row per text, its id minted here and notified on
 *   `embed_request`; the worker writes the vector to the row and notifies
 *   the id back on `embed_reply`, which this process listens to.
 * - Bounded: no reply within `LOCAL_EMBED_TIMEOUT_MS` fails, and the search
 *   runs lexical. A reply that lands just after is still read: the final
 *   delete returns whatever the row holds.
 * - Every row this asks for is deleted here, answered or not.
 */

/**
 * How long a query waits for the worker. A warm model answers in tens of
 * milliseconds; a cold one is loading, and the query falls back rather than
 * holding the palette's second wave.
 */
export const LOCAL_EMBED_TIMEOUT_MS = 500

/** Its `application_name`, which names the backend in `pg_stat_activity`. */
export const REPLY_LISTENER_APPLICATION_NAME = 'spaces-web-embed-reply'

/** The worker did not answer: no reply in time, an error it wrote, or no listener. */
export class LocalEmbedUnanswered extends Schema.TaggedError<LocalEmbedUnanswered>()(
  'LocalEmbedUnanswered',
  { reason: Schema.String },
) {}

type ReplyListener = {
  readonly ready: Promise<void>
  readonly waiters: Map<string, () => void>
  readonly close: () => void
}

let shared: ReplyListener | null = null

const ignore = () => undefined

/**
 * The process's `LISTEN embed_reply` connection, opened on the first request.
 * A lost connection is dropped and the next request opens another; waiters
 * of the lost one time out and read their rows anyway.
 */
function replyListener(): ReplyListener {
  if (shared !== null) return shared
  const client = new Client({
    connectionString: requireEnv('DATABASE_URL'),
    application_name: REPLY_LISTENER_APPLICATION_NAME,
    keepAlive: true,
  })
  const waiters = new Map<string, () => void>()
  const lost = () => {
    if (shared?.waiters === waiters) shared = null
    void client.end().catch(ignore)
  }
  // Never without a handler: an unhandled 'error' event kills the process.
  client.on('error', lost)
  client.on('end', lost)
  client.on('notification', (message) => {
    if (message.channel !== LOCAL_EMBED_REPLY_CHANNEL) return
    const id = message.payload ?? ''
    waiters.get(id)?.()
  })
  const ready = client
    .connect()
    .then(() => client.query(`LISTEN ${LOCAL_EMBED_REPLY_CHANNEL}`))
    .then(ignore)
  ready.catch(lost)
  shared = { ready, waiters, close: lost }
  return shared
}

/** Closes the listener; the next request opens a new one. For tests. */
export function closeLocalEmbedListener(): void {
  shared?.close()
}

const ask = (id: string, model: string, text: string) =>
  Effect.tryPromise({
    try: () =>
      db.execute(sql`with asked as (
        insert into ${embedRequest} (id, model, text)
        values (${id}::uuid, ${model}, ${text})
        returning id
      )
      select pg_notify(${LOCAL_EMBED_REQUEST_CHANNEL}, asked.id::text) from asked`),
    catch: (cause) =>
      new LocalEmbedUnanswered({
        reason: `could not ask the worker: ${String(cause)}`,
      }),
  })

/** Reads and deletes every row asked for, in one statement. */
const collect = (ids: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () =>
      db
        .delete(embedRequest)
        .where(inArray(embedRequest.id, [...ids]))
        .returning({
          id: embedRequest.id,
          embedding: embedRequest.embedding,
          error: embedRequest.error,
        }),
    catch: (cause) =>
      new LocalEmbedUnanswered({
        reason: `could not read the answer: ${String(cause)}`,
      }),
  })

/**
 * One vector per text from the worker's local model, in order, or
 * `LocalEmbedUnanswered`. The width is not checked here; `embed()` does it.
 */
export const requestLocalEmbeddingProgram = Effect.fn('requestLocalEmbedding')(
  function* (
    model: string,
    texts: ReadonlyArray<string>,
    timeoutMs: number = LOCAL_EMBED_TIMEOUT_MS,
  ): Effect.fn.Return<Array<Array<number>>, LocalEmbedUnanswered> {
    if (texts.length === 0) return []
    const ids = texts.map(() => randomUUID())
    const listener = replyListener()
    // Waiters before the rows exist, so no reply can arrive unheard.
    const replies = ids.map(
      (id) =>
        new Promise<void>((resolve) => {
          listener.waiters.set(id, resolve)
        }),
    )

    const roundTrip = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => listener.ready,
        catch: (cause) =>
          new LocalEmbedUnanswered({
            reason: `could not listen for the answer: ${String(cause)}`,
          }),
      })
      yield* Effect.forEach(texts, (text, i) => ask(ids[i], model, text), {
        discard: true,
      })
      yield* Effect.promise(() => Promise.all(replies))
    })
    const waited = yield* roundTrip.pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.result,
      Effect.ensuring(
        Effect.sync(() => {
          for (const id of ids) listener.waiters.delete(id)
        }),
      ),
    )

    const rows = yield* collect(ids)
    const byId = new Map(rows.map((r) => [r.id, r]))
    const vectors: Array<Array<number>> = []
    for (const id of ids) {
      const row = byId.get(id)
      if (row?.error)
        return yield* new LocalEmbedUnanswered({ reason: row.error })
      if (!row?.embedding) {
        if (waited._tag === 'Failure') return yield* waited.failure
        return yield* new LocalEmbedUnanswered({
          reason: `no answer from the worker within ${String(timeoutMs)}ms`,
        })
      }
      vectors.push(row.embedding)
    }
    return vectors
  },
)
