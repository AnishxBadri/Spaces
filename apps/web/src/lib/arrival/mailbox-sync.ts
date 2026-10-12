import { Effect, Schema } from 'effect'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  integration,
  interaction,
  note,
} from '@spaces/db/schema'
import { deleteEntityProgram } from '@spaces/core/writes/entities/delete'
import { removeInteractions } from '@spaces/core/writes/interactions/remove'
import { reclaimBlobIfOrphaned } from '#/lib/documents/blob-refs'
import { mailExclusion, senderEntry } from './noise'
import { syncedMailConfig, syncedMailSettingsOf } from './synced-settings'
import type { SyncedMailSettings } from './synced-settings'
import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import type {
  MailboxSyncInput,
  MailboxSyncResult,
  MailboxSyncView,
} from '#/lib/connections/input'
import { PRODUCTS } from '#/lib/connections/products'

/**
 * A synced mailbox's settings on its account page: whether its bodies are
 * shared, and its exclude list (D67). Only the connection's owner reads or
 * saves them — not an admin — because they decide who reads the owner's mail.
 * - The toggle moves the visibility of every body already synced; `canRead`
 *   enforces it on each read path, so nothing is copied or redacted.
 * - A save whose list now names mail already synced takes that mail out: its
 *   interactions, edges and body notes. Files that arrived on it stay.
 */

export class MailboxSyncFailed extends Schema.TaggedError<MailboxSyncFailed>()(
  'MailboxSyncFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const failed = (message: string) => (cause: unknown) =>
  new MailboxSyncFailed({ message, cause })

/** The plugin a Gmail connection syncs through. */
export const MAIL_SYNC_PLUGIN = PRODUCTS.google.gmail.plugin

type Bound = { integrationId: string; settings: SyncedMailSettings }

/** The mail syncer bound to the user's own connection, or null. */
const boundSyncer = (userId: string, connectionId: string) =>
  Effect.tryPromise({
    try: () =>
      db
        .select({ id: integration.id, config: integration.config })
        .from(integration)
        .innerJoin(
          accountConnection,
          eq(accountConnection.id, integration.connectionId),
        )
        .where(
          and(
            eq(accountConnection.id, connectionId),
            eq(accountConnection.userId, userId),
            eq(integration.capabilityId, MAIL_SYNC_PLUGIN),
            isNull(integration.removedAt),
          ),
        )
        .then((rows): Bound | null => {
          const row = rows.at(0)
          return row === undefined
            ? null
            : {
                integrationId: row.id,
                settings: syncedMailSettingsOf(row.config),
              }
        }),
    catch: failed('Could not read the mailbox settings'),
  })

const viewOf = (settings: SyncedMailSettings): MailboxSyncView => ({
  shareBodies: settings.shareBodies,
  excludeSenders: [...settings.exclude.senders],
  excludeLabels: [...settings.exclude.labels],
})

/** The account page's read: null when no mail syncer is bound to this connection. */
export const mailboxSyncProgram = Effect.fn('mailboxSync')(function* (
  userId: string,
  connectionId: string,
): Effect.fn.Return<MailboxSyncView | null, MailboxSyncFailed> {
  const bound = yield* boundSyncer(userId, connectionId)
  return bound === null ? null : viewOf(bound.settings)
})

export const saveMailboxSyncProgram = Effect.fn('saveMailboxSync')(function* (
  userId: string,
  input: MailboxSyncInput,
): Effect.fn.Return<MailboxSyncResult, MailboxSyncFailed> {
  const bound = yield* boundSyncer(userId, input.connectionId)
  if (bound === null)
    return yield* new MailboxSyncFailed({
      message: 'No mail sync is running on this account',
      cause: null,
    })
  const senders: Array<string> = []
  for (const raw of input.excludeSenders) {
    const entry = senderEntry(raw)
    if (entry === null)
      return yield* new MailboxSyncFailed({
        message: `“${raw}” is not a domain, an address or a local part like noreply@`,
        cause: null,
      })
    if (!senders.includes(entry)) senders.push(entry)
  }
  const labels = [...new Set(input.excludeLabels)]
  const settings: SyncedMailSettings = {
    shareBodies: input.shareBodies,
    exclude: { senders, labels },
  }

  const outcome = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const current = (
          await tx
            .select({ config: integration.config })
            .from(integration)
            .where(eq(integration.id, bound.integrationId))
            .for('update')
        ).at(0)
        await tx
          .update(integration)
          .set({
            config: { ...current?.config, ...syncedMailConfig(settings) },
          })
          .where(eq(integration.id, bound.integrationId))

        const held = await tx
          .select({
            id: interaction.id,
            noteId: interaction.noteId,
            meta: interaction.meta,
          })
          .from(interaction)
          .where(
            and(
              eq(interaction.sourceRef, bound.integrationId),
              eq(interaction.kind, 'email'),
            ),
          )
        const excluded = held.filter(
          (row) =>
            row.meta?.kind === 'email' &&
            mailExclusion(
              {
                sender: row.meta.from === '' ? null : row.meta.from,
                participants: [...row.meta.to, ...row.meta.cc],
                labels: row.meta.labels ?? [],
              },
              settings.exclude,
            ) !== null,
        )
        const { removed, noteIds } = await removeInteractions(
          tx,
          excluded.map((row) => row.id),
        )
        // Read before the rows go; reclaimed once they have.
        const mimeShas = excluded.flatMap((row) =>
          row.meta?.kind === 'email' && row.meta.mime_blob_sha !== null
            ? [row.meta.mime_blob_sha]
            : [],
        )

        const visibility = settings.shareBodies ? 'shared' : 'private'
        const kept = held
          .filter((row) => !excluded.includes(row))
          .flatMap((row) => (row.noteId === null ? [] : [row.noteId]))
        const revisited =
          kept.length === 0
            ? []
            : await tx
                .update(note)
                .set({ visibility })
                .where(
                  and(
                    inArray(note.entityId, kept),
                    // Only what moves: the count is what changed.
                    eq(
                      note.visibility,
                      settings.shareBodies ? 'private' : 'shared',
                    ),
                  ),
                )
                .returning({ id: note.entityId })
        return {
          removed,
          noteIds,
          mimeShas,
          revisited: revisited.length,
        }
      }),
    catch: failed('Could not save the mailbox settings'),
  })

  // The body notes go through the registry walk, after the rows that held them.
  for (const noteId of outcome.noteIds)
    yield* deleteEntityProgram(noteId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(`a removed email's body ${noteId} stayed`, cause),
      ),
    )

  // A removed email's raw MIME goes with it, unless another row names it.
  for (const sha of new Set(outcome.mimeShas))
    yield* Effect.tryPromise(() => reclaimBlobIfOrphaned(sha)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(`a removed email's MIME ${sha} stayed`, cause),
      ),
    )

  return {
    view: viewOf(settings),
    revisited: outcome.revisited,
    removed: outcome.removed,
  }
})

/** The server fns' bodies. `requireUser()` first, always. */
export async function mailboxSyncHandler(data: {
  connectionId: string
}): Promise<MailboxSyncView | null> {
  const user = await requireUser()
  return effectFn(mailboxSyncProgram)(user.id, data.connectionId)
}

export async function saveMailboxSyncHandler(
  data: MailboxSyncInput,
): Promise<MailboxSyncResult> {
  const user = await requireUser()
  return effectFn(saveMailboxSyncProgram)(user.id, data)
}
