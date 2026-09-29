import { Effect } from 'effect'
import { asc } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { mailbox } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { pollMailboxProgram } from '#web/lib/arrival/poll'
import { MailSchedule } from '#web/lib/arrival/schedule'
import { JobPermanent } from '../run-job'
import type { JobDef, JobRetryPolicy } from '../run-job'

/**
 * mail.poll — the forwarding mailbox's poll (SPA-56). The body is
 * `pollMailboxProgram` (`lib/arrival/poll.ts`); this is the pg-boss half.
 *
 * The data is what the schedule carries (`{ mailboxId, integrationId }`) or
 * what Settings → Arrival sends on save, and nullish-tolerant for the reason
 * `dedupeSweepData` is: pg-boss stores `null` for a schedule registered
 * without a payload. The poll reads its row itself rather than trusting the
 * id in the payload, so a stale schedule for a replaced row still polls the
 * live one; the id is there for `refs`, which is what puts the integration on
 * the `job_run` row.
 *
 * Every failure is permanent. A refused login or an unreachable host has
 * already been written to the mailbox row and set the backoff; a pg-boss
 * retry a few seconds later would be exactly the tight loop the backoff
 * exists to prevent. The next scheduled tick is the retry.
 */

export const pollMailboxData = z
  .object({
    mailboxId: z.string().uuid().optional(),
    integrationId: z.string().uuid().optional(),
  })
  .nullish()
  .transform((v) => v ?? {})

export type PollMailboxData = z.infer<typeof pollMailboxData>

export const pollMailboxRetry: JobRetryPolicy = {
  limit: 0,
  delaySeconds: 0,
  backoff: false,
}

export const pollMailbox: JobDef<PollMailboxData, MailSchedule> = {
  name: QUEUES.pollMailbox,
  schema: pollMailboxData,
  retry: pollMailboxRetry,
  // Two hundred bodies over a slow link is minutes, not hours.
  timeout: '10 minutes',
  refs: (data) => ({ integrationId: data.integrationId ?? null }),
  run: () =>
    pollMailboxProgram(new Date()).pipe(
      Effect.map((outcome) => outcome.summary),
      Effect.catchTags({
        MailboxUnavailable: (e) => new JobPermanent({ reason: e.reason }),
        MailboxPollFailed: (e) =>
          new JobPermanent({
            reason: `${e.reason}: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`,
          }),
      }),
    ),
}

/**
 * The boot half of "scheduled from `cadence_minutes`": read the row and make
 * the schedule match it. With no mailbox row this unschedules, so the queue
 * exists and nothing is ever sent into it.
 */
export const syncMailScheduleProgram = Effect.fn('syncMailSchedule')(
  function* () {
    const schedule = yield* MailSchedule
    const read = yield* Effect.tryPromise(() =>
      db.select().from(mailbox).orderBy(asc(mailbox.createdAt)).limit(1),
    ).pipe(
      Effect.map((rows) => ({ ok: true as const, box: rows.at(0) ?? null })),
      Effect.catch((err) =>
        Effect.sync(() => {
          console.error(
            `[worker] ${QUEUES.pollMailbox}: could not read the mailbox`,
            err,
          )
          return { ok: false as const }
        }),
      ),
    )
    // A failed read leaves whatever schedule exists alone.
    if (!read.ok) return
    const box = read.box
    yield* schedule.sync(
      box === null
        ? null
        : {
            mailboxId: box.id,
            integrationId: box.integrationId,
            cadenceMinutes: box.cadenceMinutes,
          },
    )
  },
)
