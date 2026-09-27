import { Context, Effect, Layer } from 'effect'
import { QUEUES } from '@spaces/core/queue/names'

/**
 * When the forwarding mailbox is polled (SPA-56). The cadence is a column,
 * `mailbox.cadence_minutes`, so the schedule is data the worker keeps in step
 * with it — the way it keeps the nightly `dedupeSweep` one — rather than a
 * constant: registered while a mailbox row exists, removed when none does.
 * With no row, `mail.poll` is a registered queue with nothing scheduled into
 * it, which is what "inert until configured" means here.
 *
 * Kept in step from two places, both on the worker: at boot, and at the top
 * of every poll. Saving the mailbox in Settings → Arrival sends one poll at
 * once, so a new or re-timed mailbox is scheduled within seconds of the save
 * without the web process ever touching pg-boss's schedule table.
 */

/** What the schedule is for; null means no mailbox and no schedule. */
export type ScheduleTarget = {
  mailboxId: string
  integrationId: string
  cadenceMinutes: number
}

/** A cadence in minutes → a cron line. Sixty and above is hourly. */
export function cadenceCron(minutes: number): string {
  const n = Math.max(1, Math.floor(minutes))
  if (n >= 60) return '0 * * * *'
  if (n === 1) return '* * * * *'
  return `*/${String(n)} * * * *`
}

export class MailSchedule extends Context.Service<
  MailSchedule,
  {
    /** Make the schedule match `target`. Never fails: a failed sync is logged. */
    readonly sync: (target: ScheduleTarget | null) => Effect.Effect<void>
  }
>()('spaces/arrival/MailSchedule') {}

/** The slice of pg-boss the schedule needs — a PgBoss instance satisfies it. */
export interface ScheduleClient {
  schedule: (
    name: string,
    cron: string,
    data?: object,
    options?: { tz?: string },
  ) => Promise<unknown>
  unschedule: (name: string) => Promise<unknown>
}

/**
 * The live implementation over a pg-boss client. `schedule` is an upsert on
 * the queue name, so re-syncing an unchanged cadence is a no-op in effect;
 * `unschedule` of a queue with no schedule is harmless.
 */
export function mailScheduleLayer(client: ScheduleClient) {
  return Layer.succeed(
    MailSchedule,
    MailSchedule.of({
      sync: (target) =>
        Effect.tryPromise({
          try: () =>
            target === null
              ? client.unschedule(QUEUES.pollMailbox)
              : client.schedule(
                  QUEUES.pollMailbox,
                  cadenceCron(target.cadenceMinutes),
                  {
                    mailboxId: target.mailboxId,
                    integrationId: target.integrationId,
                  },
                  { tz: 'Etc/UTC' },
                ),
          catch: (err) => err,
        }).pipe(
          Effect.asVoid,
          Effect.catch((err) =>
            Effect.sync(() =>
              console.error(
                `[worker] ${QUEUES.pollMailbox}: could not sync the schedule —`,
                err,
              ),
            ),
          ),
        ),
    }),
  )
}
