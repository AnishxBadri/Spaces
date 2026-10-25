import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { normalizeEmail } from '@spaces/sdk/identity'
import { canRead } from '@spaces/core/read-policy'
import {
  canReadDocumentSql,
  noteWidenedSql,
} from '@spaces/core/writes/read/can-read-sql'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  emailDraft,
  entity,
  entityAlias,
  interaction,
  interactionDocument,
  note,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type {
  DraftAttachment,
  DraftRecipient,
  EmailDraftMode,
} from '@spaces/db/schema/drafts'
import { likeArg } from '#/lib/views/paging'
import {
  draftSubject,
  forwardQuote,
  replyAddresses,
} from './email-draft-prefill'
import type { ReplyMode } from './email-draft-prefill'

/**
 * Email drafts: the composer's store, author-private and local only.
 * - Every read and write filters on `user_id = viewer`; another member's
 *   draft reads as missing, never as forbidden.
 * - Saved by id: the composer mints the id, so an autosave racing the next
 *   one updates the same row rather than writing two.
 * - Attachments are read back through `canReadDocumentSql`, so a draft never
 *   shows a file its author may no longer read.
 */

export class DraftFailed extends Schema.TaggedError<DraftFailed>()(
  'DraftFailed',
  { cause: Schema.Defect() },
) {}

export class DraftNotFound extends Schema.TaggedError<DraftNotFound>()(
  'DraftNotFound',
  { id: Schema.String },
) {}

/** The sentence a client is shown; a `Schema.TaggedError` carries none. */
export function draftMessage(failure: unknown): string {
  if (failure instanceof DraftNotFound) return 'That draft is no longer there'
  return 'Could not save the draft'
}

/** A file the draft carries, named for its chip. */
export type DraftDocument = { documentId: string; name: string }

/** What the composer edits. */
export type DraftFields = {
  mode: EmailDraftMode
  inReplyToId: string | null
  to: Array<DraftRecipient>
  cc: Array<DraftRecipient>
  bcc: Array<DraftRecipient>
  subject: string
  bodyMd: string
  attachments: Array<DraftDocument>
}

export type EmailDraft = DraftFields & {
  id: string
  /** ISO instant of the last save. */
  updatedAt: string
}

/** One row of the drafts list. */
export type DraftRow = {
  id: string
  mode: EmailDraftMode
  subject: string
  to: Array<DraftRecipient>
  updatedAt: string
}

/** A reply opened from the email window: the draft held, and each mode's start. */
export type ReplyOpening = {
  draft: EmailDraft | null
  modes: { [M in ReplyMode]: DraftFields }
}

/** A person the recipient search found, with every email alias they hold. */
export type RecipientMatch = {
  entityId: string
  name: string
  emails: Array<string>
}

export type DraftSave = {
  id: string
  mode: EmailDraftMode
  inReplyToId: string | null
  to: Array<DraftRecipient>
  cc: Array<DraftRecipient>
  bcc: Array<DraftRecipient>
  subject: string
  bodyMd: string
  attachments: Array<DraftAttachment>
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DraftFailed({ cause }) })

/** The documents among `ids` the viewer may read, named, in the order given. */
export const namedDocuments = Effect.fn('draftDocuments')(function* (
  viewerId: string,
  ids: ReadonlyArray<string>,
) {
  if (ids.length === 0) return []
  const rows = yield* query(() =>
    db
      .select({ documentId: document.entityId, name: entity.canonicalName })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(inArray(document.entityId, [...ids]), canReadDocumentSql(viewerId)),
      ),
  )
  const byId = new Map(rows.map((r) => [r.documentId, r]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    return row === undefined ? [] : [row]
  })
})

export const listDraftsProgram = Effect.fn('listDraftsProgram')(
  function* (viewer: {
    id: string
  }): Effect.fn.Return<Array<DraftRow>, DraftFailed> {
    const rows = yield* query(() =>
      db
        .select({
          id: emailDraft.id,
          mode: emailDraft.mode,
          subject: emailDraft.subject,
          to: emailDraft.to,
          updatedAt: emailDraft.updatedAt,
        })
        .from(emailDraft)
        .where(eq(emailDraft.userId, viewer.id))
        .orderBy(desc(emailDraft.updatedAt)),
    )
    return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }))
  },
)

export const countDraftsProgram = Effect.fn('countDraftsProgram')(
  function* (viewer: { id: string }): Effect.fn.Return<number, DraftFailed> {
    const row = (yield* query(() =>
      db
        .select({ n: count() })
        .from(emailDraft)
        .where(eq(emailDraft.userId, viewer.id)),
    )).at(0)
    return row?.n ?? 0
  },
)

const draftOf = Effect.fn('draftOf')(function* (
  viewer: { id: string },
  where: SQL,
) {
  const row = (yield* query(() =>
    db
      .select()
      .from(emailDraft)
      .where(and(eq(emailDraft.userId, viewer.id), where))
      .orderBy(desc(emailDraft.updatedAt))
      .limit(1),
  )).at(0)
  if (row === undefined) return null
  const attachments = yield* namedDocuments(
    viewer.id,
    row.attachments.map((a) => a.documentId),
  )
  return {
    id: row.id,
    mode: row.mode,
    inReplyToId: row.inReplyToId,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    bodyMd: row.bodyMd,
    attachments,
    updatedAt: row.updatedAt.toISOString(),
  } satisfies EmailDraft
})

export const getDraftProgram = Effect.fn('getDraftProgram')(function* (
  viewer: { id: string },
  id: string,
): Effect.fn.Return<EmailDraft, DraftFailed | DraftNotFound> {
  const draft = yield* draftOf(viewer, eq(emailDraft.id, id))
  if (draft === null) return yield* new DraftNotFound({ id })
  return draft
})

/**
 * Upserts by id. A row with this id that is someone else's is not touched:
 * the update's `where` refuses it and the empty `returning` is not-found.
 */
export const saveDraftProgram = Effect.fn('saveDraftProgram')(function* (
  viewer: { id: string },
  input: DraftSave,
): Effect.fn.Return<
  { id: string; updatedAt: string },
  DraftFailed | DraftNotFound
> {
  const fields = {
    mode: input.mode,
    inReplyToId: input.inReplyToId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    bodyMd: input.bodyMd,
    attachments: input.attachments,
  }
  const row = (yield* query(() =>
    db
      .insert(emailDraft)
      .values({ id: input.id, userId: viewer.id, ...fields })
      .onConflictDoUpdate({
        target: emailDraft.id,
        set: { ...fields, updatedAt: sql`now()` },
        setWhere: eq(emailDraft.userId, viewer.id),
      })
      .returning({ id: emailDraft.id, updatedAt: emailDraft.updatedAt }),
  )).at(0)
  if (row === undefined) return yield* new DraftNotFound({ id: input.id })
  return { id: row.id, updatedAt: row.updatedAt.toISOString() }
})

/** Trash: the row goes. Another member's id deletes nothing. */
export const deleteDraftProgram = Effect.fn('deleteDraftProgram')(function* (
  viewer: { id: string },
  id: string,
): Effect.fn.Return<void, DraftFailed> {
  yield* query(() =>
    db
      .delete(emailDraft)
      .where(and(eq(emailDraft.id, id), eq(emailDraft.userId, viewer.id))),
  )
})

/** The viewer's own addresses: their login and every connected mailbox. */
const ownAddresses = Effect.fn('ownAddresses')(function* (viewerId: string) {
  const login = yield* query(() =>
    db.select({ email: user.email }).from(user).where(eq(user.id, viewerId)),
  )
  const mailboxes = yield* query(() =>
    db
      .select({ email: accountConnection.externalEmail })
      .from(accountConnection)
      .where(eq(accountConnection.userId, viewerId)),
  )
  return [...login, ...mailboxes].map((r) => r.email)
})

/** Addresses → chips, named where the address is a person's email alias. */
const chipsOf = Effect.fn('draftChips')(function* (
  emails: ReadonlyArray<string>,
) {
  const keys = [
    ...new Set(emails.map((e) => normalizeEmail(e)).filter((e) => e !== null)),
  ]
  const rows =
    keys.length === 0
      ? []
      : yield* query(() =>
          db
            .select({
              key: entityAlias.valueNorm,
              entityId: entity.id,
              name: entity.canonicalName,
            })
            .from(entityAlias)
            .innerJoin(entity, eq(entity.id, entityAlias.entityId))
            .where(
              and(
                eq(entityAlias.kind, 'email'),
                inArray(entityAlias.valueNorm, keys),
                eq(entity.kind, 'person'),
                isNull(entity.mergedIntoId),
              ),
            ),
        )
  const people = new Map(rows.map((r) => [r.key, r]))
  return (list: ReadonlyArray<string>): Array<DraftRecipient> =>
    list.map((email) => {
      const person = people.get(normalizeEmail(email) ?? '')
      return person === undefined
        ? { email }
        : { email, entityId: person.entityId, name: person.name }
    })
})

/**
 * A reply opened from the email window: the viewer's draft on this email if
 * one is held, and what each mode starts from. The quoted body and the
 * files a forward carries are only those the viewer may read.
 */
export const openReplyProgram = Effect.fn('openReplyProgram')(function* (
  viewer: { id: string },
  parentId: string,
): Effect.fn.Return<ReplyOpening, DraftFailed | DraftNotFound> {
  const parent = (yield* query(() =>
    db
      .select({
        subject: interaction.subject,
        meta: interaction.meta,
        bodyMd: note.bodyMd,
        visibility: note.visibility,
        authorId: note.authorId,
        widened: noteWidenedSql(viewer.id),
      })
      .from(interaction)
      .leftJoin(note, eq(note.entityId, interaction.noteId))
      .where(and(eq(interaction.id, parentId), eq(interaction.kind, 'email'))),
  )).at(0)
  if (parent === undefined) return yield* new DraftNotFound({ id: parentId })
  const meta =
    parent.meta?.kind === 'email'
      ? parent.meta
      : { from: '', to: [], cc: [], date: '' }

  const readable = canRead(viewer, {
    visibility: parent.visibility,
    authorId: parent.authorId,
    widened: parent.widened,
  })
  const files = readable
    ? yield* query(() =>
        db
          .select({ id: interactionDocument.documentId })
          .from(interactionDocument)
          .innerJoin(entity, eq(entity.id, interactionDocument.documentId))
          .where(
            and(
              eq(interactionDocument.interactionId, parentId),
              eq(interactionDocument.role, 'attachment'),
            ),
          )
          .orderBy(asc(entity.canonicalName)),
      )
    : []
  const attachments = yield* namedDocuments(
    viewer.id,
    files.map((f) => f.id),
  )

  const own = yield* ownAddresses(viewer.id)
  const chips = yield* chipsOf([meta.from, ...meta.to, ...meta.cc])
  const start = (mode: ReplyMode): DraftFields => {
    const { to, cc } = replyAddresses(meta, own, mode)
    return {
      mode,
      inReplyToId: parentId,
      to: chips(to),
      cc: chips(cc),
      bcc: [],
      subject: draftSubject(parent.subject, mode),
      bodyMd:
        mode === 'forward'
          ? forwardQuote({
              ...meta,
              subject: parent.subject,
              body: readable ? (parent.bodyMd ?? '') : null,
            })
          : '',
      attachments: mode === 'forward' ? attachments : [],
    }
  }
  const draft = yield* draftOf(viewer, eq(emailDraft.inReplyToId, parentId))
  return {
    draft,
    modes: {
      reply: start('reply'),
      reply_all: start('reply_all'),
      forward: start('forward'),
    },
  }
})

const RECIPIENT_LIMIT = 8

/** People matched by name or by an email alias; only people who have one. */
export const searchRecipientsProgram = Effect.fn('searchRecipientsProgram')(
  function* (q: string): Effect.fn.Return<Array<RecipientMatch>, DraftFailed> {
    const term = q.trim()
    if (term === '') return []
    const pattern = likeArg(term.toLowerCase())
    const people = yield* query(() =>
      db
        .selectDistinct({ id: entity.id, name: entity.canonicalName })
        .from(entity)
        .innerJoin(
          entityAlias,
          and(
            eq(entityAlias.entityId, entity.id),
            eq(entityAlias.kind, 'email'),
          ),
        )
        .where(
          and(
            eq(entity.kind, 'person'),
            isNull(entity.mergedIntoId),
            or(
              ilike(entity.canonicalName, pattern),
              ilike(entityAlias.valueNorm, pattern),
            ),
          ),
        )
        .orderBy(asc(entity.canonicalName))
        .limit(RECIPIENT_LIMIT),
    )
    if (people.length === 0) return []
    const aliases = yield* query(() =>
      db
        .select({ entityId: entityAlias.entityId, email: entityAlias.value })
        .from(entityAlias)
        .where(
          and(
            inArray(
              entityAlias.entityId,
              people.map((p) => p.id),
            ),
            eq(entityAlias.kind, 'email'),
          ),
        )
        .orderBy(desc(entityAlias.isIdentity), asc(entityAlias.createdAt)),
    )
    return people.map((p) => ({
      entityId: p.id,
      name: p.name,
      emails: aliases.filter((a) => a.entityId === p.id).map((a) => a.email),
    }))
  },
)
