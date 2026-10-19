import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { emailOpenedToWorkspaceSql } from '@spaces/core/writes/read/can-read-sql'
import { db } from '@spaces/db'
import {
  emailGrant,
  emailVisibility,
  entity,
  interaction,
  note,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'

/**
 * Who reads a synced email past its owner (D67): the owner's override on a
 * record (`email_visibility`) and their grants on one email (`email_grant`).
 * `canRead` and its SQL twins enforce both at read time; this module only
 * reads them for the privacy row and writes them for the owner.
 * - Only the owner widens: the body note's author, while it is private.
 * - The override and the grants are written apart; removing one never
 *   touches the other.
 */

export class EmailPrivacyFailed extends Schema.TaggedError<EmailPrivacyFailed>()(
  'EmailPrivacyFailed',
  { cause: Schema.Defect() },
) {}

/** Not the owner's private email: the same answer whether it exists or not. */
export class EmailNotWidenable extends Schema.TaggedError<EmailNotWidenable>()(
  'EmailNotWidenable',
  { id: Schema.String },
) {}

export class RecordNotFound extends Schema.TaggedError<RecordNotFound>()(
  'RecordNotFound',
  { id: Schema.String },
) {}

/** The sentence a client is shown; a `Schema.TaggedError` carries none. */
export function emailPrivacyMessage(failure: unknown): string {
  if (failure instanceof EmailNotWidenable)
    return 'Only its owner can widen this email'
  if (failure instanceof RecordNotFound) return 'That record is no longer there'
  return 'Could not save who sees it'
}

export type EmailMember = { id: string; name: string }

/** The privacy row's facts, for a body private by default. */
export type EmailPrivacy = {
  owner: EmailMember
  /** The viewer is the owner, so the row offers `widen`. */
  mine: boolean
  /** The owner's override on a record this email is on covers it. */
  workspace: boolean
  /** Members granted this one email, by name; `you` marks the viewer. */
  grantees: Array<EmailMember & { you: boolean }>
  /**
   * The record the window was opened from, and whether the owner's override
   * is on there; null when it was opened from no record or by someone else.
   */
  record: { id: string; name: string; on: boolean } | null
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new EmailPrivacyFailed({ cause }),
  })

/** A live record, by id: what an override may name. */
const liveRecord = Effect.fn('liveRecord')(function* (entityId: string) {
  const row = (yield* query(() =>
    db
      .select({ id: entity.id, name: entity.canonicalName })
      .from(entity)
      .where(and(eq(entity.id, entityId), isNull(entity.mergedIntoId))),
  )).at(0)
  if (!row) return yield* new RecordNotFound({ id: entityId })
  return row
})

/**
 * The privacy row of one email whose body is private: owner, override and
 * grants. `recordId` is the record the window was opened from.
 */
export const emailPrivacyProgram = Effect.fn('emailPrivacyProgram')(function* (
  viewer: { id: string },
  email: { id: string; owner: EmailMember },
  recordId: string | null,
): Effect.fn.Return<EmailPrivacy, EmailPrivacyFailed> {
  const opened = (yield* query(() =>
    db.execute<{ opened: boolean }>(
      sql`select ${emailOpenedToWorkspaceSql(
        sql`${email.id}::uuid`,
        sql`${email.owner.id}`,
      )} as opened`,
    ),
  )).rows.at(0)
  const grantees = yield* query(() =>
    db
      .select({ id: user.id, name: user.name })
      .from(emailGrant)
      .innerJoin(user, eq(user.id, emailGrant.userId))
      .where(eq(emailGrant.interactionId, email.id))
      .orderBy(asc(user.name)),
  )
  const mine = viewer.id === email.owner.id
  const record =
    mine && recordId !== null
      ? (yield* query(() =>
          db
            .select({
              id: entity.id,
              name: entity.canonicalName,
              on: sql<boolean>`exists (
                select 1 from ${emailVisibility}
                where ${emailVisibility.entityId} = ${recordId}::uuid
                  and ${emailVisibility.userId} = ${viewer.id}
              )`,
            })
            .from(entity)
            .where(eq(entity.id, recordId)),
        )).at(0)
      : undefined
  return {
    owner: email.owner,
    mine,
    workspace: opened?.opened === true,
    grantees: grantees.map((g) => ({ ...g, you: g.id === viewer.id })),
    record: record ?? null,
  }
})

/** The owner's private email, or `EmailNotWidenable` for anyone else. */
const ownedEmail = Effect.fn('ownedEmail')(function* (
  owner: { id: string },
  interactionId: string,
) {
  const row = (yield* query(() =>
    db
      .select({ id: interaction.id })
      .from(interaction)
      .innerJoin(note, eq(note.entityId, interaction.noteId))
      .where(
        and(
          eq(interaction.id, interactionId),
          eq(interaction.kind, 'email'),
          eq(note.visibility, 'private'),
          eq(note.authorId, owner.id),
        ),
      ),
  )).at(0)
  if (!row) return yield* new EmailNotWidenable({ id: interactionId })
  return row
})

/** Turns the owner's override on one record on or off; grants are untouched. */
export const setRecordEmailVisibilityProgram = Effect.fn(
  'setRecordEmailVisibilityProgram',
)(function* (
  owner: { id: string },
  input: { entityId: string; workspace: boolean },
): Effect.fn.Return<void, EmailPrivacyFailed | RecordNotFound> {
  const record = yield* liveRecord(input.entityId)
  yield* query(() =>
    input.workspace
      ? db
          .insert(emailVisibility)
          .values({ entityId: record.id, userId: owner.id })
          .onConflictDoNothing()
      : db
          .delete(emailVisibility)
          .where(
            and(
              eq(emailVisibility.entityId, record.id),
              eq(emailVisibility.userId, owner.id),
            ),
          ),
  )
})

/** Whether the viewer's emails with this record are open to the workspace. */
export const recordEmailVisibilityProgram = Effect.fn(
  'recordEmailVisibilityProgram',
)(function* (
  viewer: { id: string },
  entityId: string,
): Effect.fn.Return<{ workspace: boolean }, EmailPrivacyFailed> {
  const row = (yield* query(() =>
    db
      .select({ entityId: emailVisibility.entityId })
      .from(emailVisibility)
      .where(
        and(
          eq(emailVisibility.entityId, entityId),
          eq(emailVisibility.userId, viewer.id),
        ),
      ),
  )).at(0)
  return { workspace: row !== undefined }
})

/**
 * The widen dialog's save: the grant set on one email, and — when it was
 * opened from a record — the override there. Ticked is written, unticked
 * removed; the owner is never a grantee.
 */
export const setEmailAudienceProgram = Effect.fn('setEmailAudienceProgram')(
  function* (
    owner: { id: string },
    input: {
      interactionId: string
      userIds: ReadonlyArray<string>
      record: { id: string; workspace: boolean } | null
    },
  ): Effect.fn.Return<
    void,
    EmailPrivacyFailed | EmailNotWidenable | RecordNotFound
  > {
    const email = yield* ownedEmail(owner, input.interactionId)
    const wanted = [...new Set(input.userIds)].filter((id) => id !== owner.id)
    const members =
      wanted.length === 0
        ? []
        : (yield* query(() =>
            db
              .select({ id: user.id })
              .from(user)
              .where(inArray(user.id, wanted)),
          )).map((m) => m.id)
    yield* query(() =>
      db.transaction(async (tx) => {
        await tx
          .delete(emailGrant)
          .where(
            members.length === 0
              ? eq(emailGrant.interactionId, email.id)
              : and(
                  eq(emailGrant.interactionId, email.id),
                  notInArray(emailGrant.userId, members),
                ),
          )
        if (members.length > 0)
          await tx
            .insert(emailGrant)
            .values(
              members.map((userId) => ({
                interactionId: email.id,
                userId,
                grantedBy: owner.id,
              })),
            )
            .onConflictDoNothing()
      }),
    )
    if (input.record !== null)
      yield* setRecordEmailVisibilityProgram(owner, {
        entityId: input.record.id,
        workspace: input.record.workspace,
      })
  },
)
