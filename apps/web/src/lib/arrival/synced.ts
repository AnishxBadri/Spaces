import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { accountConnection, integration } from '@spaces/db/schema'
import type { EmailResult } from '@spaces/sdk'
import type {
  EmailInput,
  EmailLaneContext,
} from '@spaces/core/writes/interactions/email-lane'
import { fileArrivalProgram } from './file'
import { arrivalFromSource } from './message'
import { mailExclusion } from './noise'
import { syncedMailSettingsOf } from './synced-settings'
import type { SyncedMailSettings } from './synced-settings'

/**
 * The synced mailbox's arrival lane: what `Content.logEmail` files through,
 * on the forwarding mailbox's parser, noise rules, participants module and
 * writer, so a thread both forwarded and synced is one interaction.
 * - The bound connection decides: its owner authors the body, its address
 *   is never a participant, and its settings say who reads the body (D67).
 * - Refused before anything is stored: mail received before the connection
 *   (forward-only), noise, and whatever the exclude list names.
 */

export class SyncedMailFailed extends Schema.TaggedError<SyncedMailFailed>()(
  'SyncedMailFailed',
  { cause: Schema.Defect() },
) {}

export type SyncedMailbox = {
  integrationId: string
  ownerId: string
  address: string
  connectedAt: Date
  settings: SyncedMailSettings
}

/** The integration's bound mailbox, or null when no connection is bound. */
export const syncedMailboxProgram = Effect.fn('syncedMailbox')(function* (
  integrationId: string,
): Effect.fn.Return<SyncedMailbox | null, SyncedMailFailed> {
  const row = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          config: integration.config,
          ownerId: accountConnection.userId,
          address: accountConnection.externalEmail,
          connectedAt: accountConnection.createdAt,
        })
        .from(integration)
        .innerJoin(
          accountConnection,
          eq(accountConnection.id, integration.connectionId),
        )
        .where(eq(integration.id, integrationId))
        .then((rows) => rows.at(0)),
    catch: (cause) => new SyncedMailFailed({ cause }),
  })
  if (row === undefined) return null
  return {
    integrationId,
    ownerId: row.ownerId,
    address: row.address,
    connectedAt: row.connectedAt,
    settings: syncedMailSettingsOf(row.config),
  }
})

const refused = (reason: string): EmailResult => ({
  outcome: 'refused',
  reason,
})

export const logSyncedEmailProgram = Effect.fn('logSyncedEmail')(function* (
  ctx: EmailLaneContext,
  input: EmailInput,
): Effect.fn.Return<EmailResult, SyncedMailFailed> {
  const box = yield* syncedMailboxProgram(ctx.integrationId)
  if (box === null) return refused('no mailbox connection is bound')
  if (input.receivedAt.getTime() < box.connectedAt.getTime())
    return refused('received before the mailbox was connected')

  // Bytes the parser cannot read never will: a refusal, not a retry.
  const arrival = yield* Effect.tryPromise({
    try: () =>
      arrivalFromSource(Buffer.from(input.raw), {
        mailboxAddress: box.address,
        receivedAt: input.receivedAt,
      }),
    catch: (cause) => new SyncedMailFailed({ cause }),
  }).pipe(Effect.catch(() => Effect.succeed(null)))
  if (arrival === null) return refused('unparseable: the message is not MIME')
  if (arrival.kind === 'refused')
    return refused(`${arrival.refusal.reason}: ${arrival.refusal.detail}`)
  const message = arrival.message

  const excluded = mailExclusion(
    {
      sender: message.from?.email ?? null,
      participants: message.participants.map((p) => p.email),
      labels: input.labels,
    },
    box.settings.exclude,
  )
  if (excluded !== null)
    return refused(`${excluded.reason}: ${excluded.detail}`)

  const filed = yield* fileArrivalProgram(
    message,
    { integrationId: box.integrationId, authorId: box.ownerId },
    {
      visibility: box.settings.shareBodies ? 'shared' : 'private',
      labels: input.labels,
    },
  ).pipe(Effect.mapError((e) => new SyncedMailFailed({ cause: e.cause })))
  return filed.kind === 'duplicate'
    ? { outcome: 'duplicate' }
    : { outcome: 'created', interactionId: filed.interactionId }
})
