import { Effect, Schema } from 'effect'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { mailbox } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { resolveSecretById } from '#/lib/vault'
import { fileArrivalProgram } from './file'
import { fetchSince } from './imap'
import type { MailFailure, MailboxConnection } from './imap'
import { arrivalFromSource } from './message'
import type { NoiseReason } from './noise'
import { MailSchedule } from './schedule'

/**
 * One poll of the forwarding mailbox (SPA-56): the body of the `mail.poll`
 * job, outside `worker/` so the suite drives it against the fake IMAP server
 * with no pg-boss in sight.
 *
 * In order: keep the schedule in step with the row (or remove it when there
 * is none), honour the backoff, decrypt the app password, read everything
 * above the cursor, and file each message — refused, duplicate or written —
 * before moving the cursor to the last UID that was dealt with. The return
 * value is the one line `runJob` writes to `job_run.summary`, which is where
 * "why did nothing appear" is answered: `refused 1 (auto-submitted 1)`.
 *
 * **A refused login backs off.** The server's reason goes on the row
 * (`status: 'error'`, `last_error`), the attempt fails permanently — pg-boss
 * does not retry it — and the scheduled ticks that follow are skipped until
 * `cadence × 2^failures` minutes (capped at six hours) have passed since the
 * last try. An app password that was revoked therefore costs the mail server
 * a handful of logins a day, not one a minute, and saving a new one in
 * Settings → Arrival resets the count.
 */

export class MailboxPollFailed extends Schema.TaggedError<MailboxPollFailed>()(
  'MailboxPollFailed',
  { reason: Schema.String, cause: Schema.Defect() },
) {}

/** The login or the connection failed; the row already says so. */
export class MailboxUnavailable extends Schema.TaggedError<MailboxUnavailable>()(
  'MailboxUnavailable',
  { reason: Schema.String },
) {}

export type PollOutcome = {
  summary: string
  fetched: number
  written: number
  duplicate: number
  refused: Partial<Record<NoiseReason | 'unparseable', number>>
}

const BACKOFF_CAP_MINUTES = 360

/** When a mailbox that has failed `failures` times in a row may be tried again. */
export function nextAttemptAt(
  lastPolledAt: Date,
  cadenceMinutes: number,
  failures: number,
): Date {
  const minutes = Math.min(
    cadenceMinutes * 2 ** Math.max(0, failures),
    BACKOFF_CAP_MINUTES,
  )
  return new Date(lastPolledAt.getTime() + minutes * 60_000)
}

const query = <T>(reason: string, run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MailboxPollFailed({ reason, cause }),
  })

/**
 * Whose name the body note carries: the workspace member who forwarded it or
 * sent it, when their address is a member's; else whoever configured the
 * mailbox; else the first admin.
 */
async function authorFor(
  address: string | null,
  fallback: string | null,
): Promise<string | null> {
  if (address !== null) {
    const member = (
      await db
        .select({ id: user.id })
        .from(user)
        .where(sql`lower(${user.email}) = ${address.toLowerCase()}`)
        .limit(1)
    ).at(0)
    if (member) return member.id
  }
  if (fallback !== null) return fallback
  const admin = (
    await db
      .select({ id: user.id })
      .from(user)
      .orderBy(sql`${user.role} = 'admin' desc`, asc(user.createdAt))
      .limit(1)
  ).at(0)
  return admin?.id ?? null
}

function describe(o: Omit<PollOutcome, 'summary'>, extra: Array<string>) {
  const refusedTotal = Object.values(o.refused).reduce((a, b) => a + b, 0)
  const reasons = Object.entries(o.refused)
    .map(([reason, n]) => `${reason} ${String(n)}`)
    .join(', ')
  return [
    `fetched ${String(o.fetched)}`,
    `written ${String(o.written)}`,
    `duplicate ${String(o.duplicate)}`,
    `refused ${String(refusedTotal)}${reasons ? ` (${reasons})` : ''}`,
    ...extra,
  ].join(' · ')
}

export const pollMailboxProgram = Effect.fn('pollMailbox')(function* (
  now: Date = new Date(),
): Effect.fn.Return<
  PollOutcome,
  MailboxPollFailed | MailboxUnavailable,
  MailSchedule
> {
  const schedule = yield* MailSchedule
  const box = (yield* query('could not read the mailbox', () =>
    db.select().from(mailbox).orderBy(asc(mailbox.createdAt)).limit(1),
  )).at(0)

  yield* schedule.sync(
    box
      ? {
          mailboxId: box.id,
          integrationId: box.integrationId,
          cadenceMinutes: box.cadenceMinutes,
        }
      : null,
  )
  const empty = { fetched: 0, written: 0, duplicate: 0, refused: {} }
  if (!box) return { ...empty, summary: 'no mailbox configured' }

  if (box.status === 'error' && box.failureCount > 0 && box.lastPolledAt) {
    const next = nextAttemptAt(
      box.lastPolledAt,
      box.cadenceMinutes,
      box.failureCount,
    )
    if (now < next)
      return {
        ...empty,
        summary: `backing off after ${String(box.failureCount)} failed ${box.failureCount === 1 ? 'poll' : 'polls'} until ${next.toISOString()}`,
      }
  }

  const pass = yield* query('could not read the app password', () =>
    resolveSecretById(box.credentialId),
  )
  const fail = Effect.fn('pollMailbox.fail')(function* (
    reason: string,
  ): Effect.fn.Return<never, MailboxPollFailed | MailboxUnavailable> {
    yield* query('could not record the failure', () =>
      db
        .update(mailbox)
        .set({
          status: 'error',
          lastError: reason.slice(0, 1000),
          failureCount: sql`${mailbox.failureCount} + 1`,
          lastPolledAt: now,
        })
        .where(eq(mailbox.id, box.id)),
    )
    return yield* new MailboxUnavailable({ reason })
  })
  if (pass === null) return yield* fail('The app password is missing')

  const conn: MailboxConnection = {
    host: box.host,
    port: box.port,
    secure: box.useTls,
    user: box.address,
    pass,
    folder: box.folder,
  }
  const fetched = yield* fetchSince(conn, {
    lastUid: box.lastUid,
    lastUidValidity: box.lastUidValidity,
  }).pipe(
    Effect.catch((err: MailFailure) =>
      fail(
        err._tag === 'MailAuthRefused'
          ? `Login refused: ${err.reason}`
          : `Could not reach the mailbox: ${err.reason}`,
      ),
    ),
  )

  const counts: Omit<PollOutcome, 'summary'> = {
    fetched: fetched.messages.length,
    written: 0,
    duplicate: 0,
    refused: {},
  }
  const refuse = (reason: NoiseReason | 'unparseable') => {
    counts.refused[reason] = (counts.refused[reason] ?? 0) + 1
  }
  // Where the cursor ends up: the last UID dealt with. A reset starts it at
  // zero even when the renumbered folder is empty.
  let cursor = fetched.reset ? 0 : box.lastUid
  const saveCursor = () =>
    query('could not move the cursor', () =>
      db
        .update(mailbox)
        .set({
          lastUid: cursor,
          lastUidValidity: fetched.uidValidity,
          lastPolledAt: now,
          status: 'ok',
          lastError: null,
          failureCount: 0,
        })
        .where(eq(mailbox.id, box.id)),
    )

  for (const mail of fetched.messages) {
    const arrival = yield* Effect.tryPromise({
      try: () =>
        arrivalFromSource(mail.source, {
          mailboxAddress: box.address,
          receivedAt: now,
        }),
      catch: (cause) => cause,
    }).pipe(Effect.option)

    if (arrival._tag === 'None') {
      refuse('unparseable')
    } else if (arrival.value.kind === 'refused') {
      refuse(arrival.value.refusal.reason)
    } else {
      const message = arrival.value.message
      const authorId = yield* query('could not find an author', () =>
        authorFor(
          message.forwarder?.email ?? message.from?.email ?? null,
          box.createdBy,
        ),
      )
      if (authorId === null) {
        yield* saveCursor()
        return yield* new MailboxPollFailed({
          reason: 'no workspace user to author the mail body',
          cause: null,
        })
      }
      const filed = yield* fileArrivalProgram(message, {
        integrationId: box.integrationId,
        authorId,
      }).pipe(
        // A failed write stops the poll with the cursor on the last message
        // that was dealt with, so the next tick starts at this one.
        Effect.tapError(() => saveCursor()),
        Effect.mapError(
          (e) =>
            new MailboxPollFailed({
              reason: `could not file UID ${String(mail.uid)}`,
              cause: e.cause,
            }),
        ),
      )
      if (filed.kind === 'written') counts.written++
      else counts.duplicate++
    }
    cursor = mail.uid
  }

  yield* saveCursor()
  const extra = [
    ...(fetched.reset ? ['UIDVALIDITY changed, restarted from UID 1'] : []),
    ...(fetched.remaining > 0
      ? [`${String(fetched.remaining)} left for the next poll`]
      : []),
  ]
  return { ...counts, summary: describe(counts, extra) }
})
