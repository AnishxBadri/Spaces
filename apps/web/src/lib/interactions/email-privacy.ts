import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { emailOpenedToWorkspaceSql } from '@spaces/core/writes/read/can-read-sql'
import { db } from '@spaces/db'
import {
  emailGrant,
  emailVisibility,
  entity,
  integration,
  interaction,
  interactionEntity,
  link,
  note,
  objectDef,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { syncedMailSettingsOf } from '#/lib/arrival/synced-settings'
import { PRODUCTS } from '#/lib/connections/products'

/**
 * Who reads a synced email past its owner: the mailbox sharing every body
 * (its `shareBodies` setting), the owner's override on a record
 * (`email_visibility`) and their grants on one email (`email_grant`).
 * `canRead` and its SQL twins enforce them at read time; this module only
 * reads them for the privacy row and writes the last two for the owner.
 * - Only the owner widens: the body note's author, while the body is
 *   private or shared only because the mailbox shares it.
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

/**
 * What already opens the body to the workspace, past anything the window
 * itself sets: the owner's mailbox sharing every body (its account page
 * by `connectionId`), or the owner's override on another record.
 */
export type EmailWider =
  | { kind: 'mailbox'; connectionId: string }
  | {
      kind: 'record'
      record: {
        id: string
        kind: string
        name: string
        objectSlug: string | null
      }
    }

/** The privacy row's facts, for a body private by default. */
export type EmailPrivacy = {
  owner: EmailMember
  /** The viewer is the owner, so the row offers `widen`. */
  mine: boolean
  /** The mailbox, or the owner's override on a record this email is on, opens it. */
  workspace: boolean
  /**
   * The source of `workspace` the window cannot switch itself; the mailbox
   * wins when both hold. Null when nothing does, or only the override on
   * the record the window was opened from (its own switch says that).
   */
  wider: EmailWider | null
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

const MAIL_SYNC = PRODUCTS.google.gmail.plugin

/**
 * The mail-sync mailbox an email came through, when its setting shares every
 * body; null for one that keeps bodies private, or mail that came another way
 * (forwarded, logged).
 */
const sharingMailbox = Effect.fn('sharingMailbox')(function* (
  interactionId: string,
) {
  const row = (yield* query(() =>
    db
      .select({
        config: integration.config,
        connectionId: integration.connectionId,
      })
      .from(interaction)
      .innerJoin(integration, eq(integration.id, interaction.sourceRef))
      .where(
        and(
          eq(interaction.id, interactionId),
          eq(integration.capabilityId, MAIL_SYNC),
        ),
      ),
  )).at(0)
  if (row === undefined || row.connectionId === null) return null
  return syncedMailSettingsOf(row.config).shareBodies
    ? { connectionId: row.connectionId }
    : null
})

/**
 * The first record, by name, whose override by `ownerId` opens this email:
 * the rule `emailOpenedToWorkspaceSql` enforces (a record the email is on,
 * or a deal whose company or people it is on), less `besides`.
 */
const coveringRecord = Effect.fn('coveringRecord')(function* (
  interactionId: string,
  ownerId: string,
  besides: string | null,
) {
  const onEmail = db
    .select({ id: interactionEntity.entityId })
    .from(interactionEntity)
    .where(eq(interactionEntity.interactionId, interactionId))
  return (yield* query(() =>
    db
      .select({
        id: entity.id,
        kind: entity.kind,
        name: entity.canonicalName,
        objectSlug: objectDef.slug,
      })
      .from(emailVisibility)
      .innerJoin(entity, eq(entity.id, emailVisibility.entityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(
        and(
          eq(emailVisibility.userId, ownerId),
          eq(emailVisibility.scope, 'workspace'),
          besides === null ? undefined : ne(emailVisibility.entityId, besides),
          or(
            inArray(emailVisibility.entityId, onEmail),
            and(
              eq(entity.kind, 'deal'),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(link)
                  .where(
                    and(
                      eq(link.fromEntityId, emailVisibility.entityId),
                      eq(link.relation, 'references'),
                      inArray(link.attrSlug, ['company', 'people']),
                      inArray(link.toEntityId, onEmail),
                    ),
                  ),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(entity.canonicalName))
      .limit(1),
  )).at(0)
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
 * The privacy row of one email whose body is private, or shared only by its
 * mailbox: owner, what already opens it, override and grants. Null for a
 * body shared any other way. `recordId` is the record the window was
 * opened from.
 */
export const emailPrivacyProgram = Effect.fn('emailPrivacyProgram')(function* (
  viewer: { id: string },
  email: {
    id: string
    owner: EmailMember
    visibility: 'private' | 'shared'
  },
  recordId: string | null,
): Effect.fn.Return<EmailPrivacy | null, EmailPrivacyFailed> {
  const mailbox =
    email.visibility === 'shared' ? yield* sharingMailbox(email.id) : null
  if (email.visibility === 'shared' && mailbox === null) return null
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
  const covering =
    mailbox === null
      ? yield* coveringRecord(email.id, email.owner.id, record?.id ?? null)
      : undefined
  return {
    owner: email.owner,
    mine,
    workspace: mailbox !== null || opened?.opened === true,
    wider:
      mailbox !== null
        ? { kind: 'mailbox', connectionId: mailbox.connectionId }
        : covering === undefined
          ? null
          : { kind: 'record', record: covering },
    grantees: grantees.map((g) => ({ ...g, you: g.id === viewer.id })),
    record: record ?? null,
  }
})

/**
 * The owner's email, private or shared only by their mailbox, or
 * `EmailNotWidenable` for anyone else.
 */
const ownedEmail = Effect.fn('ownedEmail')(function* (
  owner: { id: string },
  interactionId: string,
) {
  const row = (yield* query(() =>
    db
      .select({ id: interaction.id, visibility: note.visibility })
      .from(interaction)
      .innerJoin(note, eq(note.entityId, interaction.noteId))
      .where(
        and(
          eq(interaction.id, interactionId),
          eq(interaction.kind, 'email'),
          eq(note.authorId, owner.id),
        ),
      ),
  )).at(0)
  if (!row) return yield* new EmailNotWidenable({ id: interactionId })
  if (row.visibility === 'shared' && (yield* sharingMailbox(row.id)) === null)
    return yield* new EmailNotWidenable({ id: interactionId })
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
