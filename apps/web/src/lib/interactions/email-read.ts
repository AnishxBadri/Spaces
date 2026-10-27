import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { simpleParser } from 'mailparser'
import { normalizeEmail } from '@spaces/sdk/identity'
import { canRead } from '@spaces/core/read-policy'
import { clean, emailListing } from '@spaces/core/interactions/email-listing'
import type { EmailCategory } from '@spaces/core/interactions/email-listing'
import {
  canReadDocumentSql,
  noteWidenedSql,
} from '@spaces/core/writes/read/can-read-sql'
import { storage } from '@spaces/core/writes/storage'
import { db } from '@spaces/db'
import {
  document,
  entity,
  entityAlias,
  integration,
  interaction,
  interactionDocument,
  note,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { sanitizeEmailHtml } from '#/lib/email/sanitize'
import { sentBy, viewerSelf } from '#/lib/timeline/record'
import { emailPrivacyProgram } from './email-privacy'
import type { EmailPrivacy } from './email-privacy'

/**
 * The email window's read: headers always, the body only through
 * `canRead` on the body note — the gate the record timeline applies.
 * - A body private to someone else returns `private`: no blob is read and
 *   no attachment is listed. Subject, participants and date stay — and
 *   who it is visible to, unless its owner widened it to the reader.
 * - The body is the stored MIME's HTML, sanitized; else its text part; else
 *   the body note's text when the bytes were never kept.
 * - The thread's other messages by `thread_id` come as one line each; a
 *   line's preview passes the same `canRead`, so a private sibling shows
 *   its sender and date and nothing of its body.
 */

export class EmailReadFailed extends Schema.TaggedError<EmailReadFailed>()(
  'EmailReadFailed',
  { cause: Schema.Defect() },
) {}

export class EmailNotFound extends Schema.TaggedError<EmailNotFound>()(
  'EmailNotFound',
  { id: Schema.String },
) {}

/** The sentence a client is shown; a `Schema.TaggedError` carries none. */
export function emailMessage(failure: unknown): string {
  if (failure instanceof EmailNotFound) return 'That email is no longer there'
  return 'Could not read the email'
}

export type EmailParticipant = {
  email: string
  /** The person record the address is an alias of; null when none. */
  name: string | null
}

export type EmailBody =
  | { kind: 'html'; srcdoc: string; remoteImages: number }
  | { kind: 'text'; text: string }
  | { kind: 'private' }
  | { kind: 'none' }

export type EmailAttachment = {
  documentId: string
  name: string
  /** For the type glyph: the filename and mime say PDF, XLS, IMG. */
  filename: string
  mime: string | null
  sizeBytes: number | null
  /** The capability of the lane that brought the file: `core.mailbox`, `gmail`. */
  lane: string | null
  /** The member whose mailbox or upload brought it; null when none is known. */
  uploader: string | null
  /** ISO instant the file was kept. */
  addedAt: string
}

/** An earlier message of the thread, folded to one line. */
export type EmailThreadLine = {
  id: string
  /** The sender, or the first recipient on a message the viewer sent. */
  who: string
  /** The viewer sent it: the line reads `To <who>`. */
  sent: boolean
  /** The summary, the snippet or the body's start; null when the body is not the reader's. */
  preview: string | null
  attachments: number
  /** ISO instant. */
  occurredAt: string
}

export type EmailThread = {
  /** Every message the thread holds, this one included. */
  messages: number
  /** The messages before this one, oldest first. */
  earlier: Array<EmailThreadLine>
}

export type EmailDetail = {
  id: string
  subject: string | null
  /** ISO instant. */
  occurredAt: string
  from: EmailParticipant | null
  to: Array<EmailParticipant>
  cc: Array<EmailParticipant>
  /** Blind copies: the sender's alone, empty for anyone else. */
  bcc: Array<EmailParticipant>
  /** Whose mailbox it came through: the body note's author. */
  via: string | null
  body: EmailBody
  attachments: Array<EmailAttachment>
  /** Who reads a body private by default; null for a shared one. */
  privacy: EmailPrivacy | null
  /** The classify lane's labels; empty while the body is not the reader's. */
  categories: Array<EmailCategory>
  thread: EmailThread
  /** The record the window was opened from, by name: whose files a reply attaches. */
  record: { id: string; name: string } | null
}

const uploader = alias(user, 'uploader')

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new EmailReadFailed({ cause }),
  })

/** Address → the name of the person whose email alias it is. */
const namesOf = Effect.fn('emailNames')(function* (
  emails: ReadonlyArray<string>,
) {
  const keys = [
    ...new Set(emails.map((e) => normalizeEmail(e)).filter((e) => e !== null)),
  ]
  if (keys.length === 0) return new Map<string, string>()
  const rows = yield* query(() =>
    db
      .select({ key: entityAlias.valueNorm, name: entity.canonicalName })
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
  return new Map(rows.map((r) => [r.key, r.name]))
})

/**
 * The stored MIME rendered, or null when it cannot be read — the caller
 * falls back to the body note rather than failing the window.
 */
const renderMime = Effect.fn('renderMime')(function* (sha: string) {
  return yield* Effect.tryPromise({
    try: async (): Promise<EmailBody | null> => {
      const bytes = await storage().getBytes(sha)
      // Defaults inline `cid:` parts as `data:` URIs.
      const parsed = await simpleParser(Buffer.from(bytes))
      if (typeof parsed.html === 'string' && parsed.html.trim() !== '')
        return { kind: 'html', ...sanitizeEmailHtml(parsed.html) }
      const text = parsed.text?.trim() ?? ''
      return text === '' ? null : { kind: 'text', text }
    },
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => null))
})

export const emailDetailProgram = Effect.fn('emailDetailProgram')(function* (
  viewer: { id: string },
  id: string,
  /** The record the window was opened from, for the widen dialog. */
  recordId: string | null = null,
): Effect.fn.Return<EmailDetail, EmailReadFailed | EmailNotFound> {
  const row = (yield* query(() =>
    db
      .select({
        id: interaction.id,
        subject: interaction.subject,
        occurredAt: interaction.occurredAt,
        meta: interaction.meta,
        threadId: interaction.threadId,
        noteId: interaction.noteId,
        bodyMd: note.bodyMd,
        visibility: note.visibility,
        authorId: note.authorId,
        widened: noteWidenedSql(viewer.id),
        authorName: user.name,
      })
      .from(interaction)
      .leftJoin(note, eq(note.entityId, interaction.noteId))
      .leftJoin(user, eq(user.id, note.authorId))
      .where(and(eq(interaction.id, id), eq(interaction.kind, 'email'))),
  )).at(0)
  if (!row) return yield* new EmailNotFound({ id })

  const meta = row.meta?.kind === 'email' ? row.meta : null
  // A Bcc is the sending mailbox's own: nobody else sees it.
  const bcc = row.authorId === viewer.id ? (meta?.bcc ?? []) : []
  const names = yield* namesOf([
    ...(meta?.from ? [meta.from] : []),
    ...(meta?.to ?? []),
    ...(meta?.cc ?? []),
    ...bcc,
  ])
  const participant = (email: string): EmailParticipant => ({
    email,
    name: names.get(normalizeEmail(email) ?? '') ?? null,
  })

  const readable = canRead(viewer, {
    visibility: row.visibility,
    authorId: row.authorId,
    widened: row.widened,
  })
  const body: EmailBody = !readable
    ? { kind: 'private' }
    : ((meta?.mime_blob_sha ? yield* renderMime(meta.mime_blob_sha) : null) ??
      (row.bodyMd !== null && row.bodyMd.trim() !== ''
        ? { kind: 'text', text: row.bodyMd }
        : { kind: 'none' }))

  const attachments = readable
    ? yield* query(() =>
        db
          .select({
            documentId: interactionDocument.documentId,
            name: entity.canonicalName,
            filename: document.filename,
            mime: document.mime,
            sizeBytes: document.sizeBytes,
            lane: integration.capabilityId,
            uploader: uploader.name,
            addedAt: document.createdAt,
          })
          .from(interactionDocument)
          .innerJoin(
            document,
            eq(document.entityId, interactionDocument.documentId),
          )
          .innerJoin(entity, eq(entity.id, interactionDocument.documentId))
          .leftJoin(integration, eq(integration.id, document.sourceRef))
          .leftJoin(uploader, eq(uploader.id, document.uploadedBy))
          .where(
            and(
              eq(interactionDocument.interactionId, id),
              eq(interactionDocument.role, 'attachment'),
              canReadDocumentSql(viewer.id),
            ),
          )
          .orderBy(asc(entity.canonicalName))
          .then((rows) =>
            rows.map((r) => ({
              ...r,
              filename: r.filename ?? r.name,
              // A synced file has no uploader: the mailbox it came through is.
              uploader: r.uploader ?? row.authorName,
              addedAt: r.addedAt.toISOString(),
            })),
          ),
      )
    : []

  const privacy =
    row.visibility === 'private' && row.authorId !== null
      ? yield* emailPrivacyProgram(
          viewer,
          {
            id: row.id,
            owner: { id: row.authorId, name: row.authorName ?? 'Someone' },
          },
          recordId,
        ).pipe(Effect.mapError((e) => new EmailReadFailed({ cause: e.cause })))
      : null

  const thread = yield* threadOf(viewer, row, names)
  const record =
    recordId === null
      ? undefined
      : (yield* query(() =>
          db
            .select({ id: entity.id, name: entity.canonicalName })
            .from(entity)
            .where(and(eq(entity.id, recordId), isNull(entity.mergedIntoId))),
        )).at(0)

  return {
    id: row.id,
    subject: row.subject,
    occurredAt: row.occurredAt.toISOString(),
    from: meta?.from ? participant(meta.from) : null,
    to: (meta?.to ?? []).map(participant),
    cc: (meta?.cc ?? []).map(participant),
    bcc: bcc.map(participant),
    via: row.authorName,
    body,
    attachments,
    privacy,
    categories: emailListing(row.meta, readable).categories,
    thread,
    record: record ?? null,
  }
})

/** How long a thread line's preview runs before it is cut on a word. */
const PREVIEW_MAX = 140

/**
 * The thread around one message: its size and the earlier messages as
 * lines. Each preview is read through `canRead` on that message's own body
 * note, and so is its attachment count: a private sibling counts none.
 */
const threadOf = Effect.fn('emailThread')(function* (
  viewer: { id: string },
  row: { id: string; threadId: string | null; occurredAt: Date },
  known: ReadonlyMap<string, string>,
) {
  const alone: EmailThread = { messages: 1, earlier: [] }
  if (row.threadId === null) return alone
  const threadId = row.threadId
  const siblings = yield* query(() =>
    db
      .select({
        id: interaction.id,
        occurredAt: interaction.occurredAt,
        meta: interaction.meta,
        bodyMd: note.bodyMd,
        visibility: note.visibility,
        authorId: note.authorId,
        widened: noteWidenedSql(viewer.id),
        attachments: sql<number>`(
          select count(*)::int from ${interactionDocument}
          where ${interactionDocument.interactionId} = ${interaction.id}
            and ${interactionDocument.role} = 'attachment'
        )`,
      })
      .from(interaction)
      .leftJoin(note, eq(note.entityId, interaction.noteId))
      .where(
        and(
          eq(interaction.threadId, threadId),
          eq(interaction.kind, 'email'),
          ne(interaction.id, row.id),
        ),
      )
      .orderBy(asc(interaction.occurredAt)),
  )
  if (siblings.length === 0) return alone
  const own = yield* viewerSelf(viewer.id).pipe(
    Effect.mapError((cause) => new EmailReadFailed({ cause })),
  )
  const earlier = siblings.filter((s) => s.occurredAt <= row.occurredAt)
  const metas = earlier.map((s) => (s.meta?.kind === 'email' ? s.meta : null))
  const more = yield* namesOf(
    metas.flatMap((m) => (m === null ? [] : [m.from, ...m.to])),
  )
  const nameOf = (email: string) => {
    const key = normalizeEmail(email) ?? ''
    return known.get(key) ?? more.get(key) ?? email
  }
  const lines = earlier.map((s, i): EmailThreadLine => {
    const meta = metas.at(i) ?? null
    const readable = canRead(viewer, {
      visibility: s.visibility,
      authorId: s.authorId,
      widened: s.widened,
    })
    const first = meta?.to.at(0)
    const sent = first !== undefined && sentBy(s.meta, own.addresses)
    const listing = emailListing(s.meta, readable)
    return {
      id: s.id,
      who: sent ? nameOf(first) : meta === null ? 'Unknown' : nameOf(meta.from),
      sent,
      preview: readable
        ? clean(
            listing.summary ?? listing.snippet ?? s.bodyMd ?? undefined,
            PREVIEW_MAX,
          )
        : null,
      attachments: readable ? Number(s.attachments) : 0,
      occurredAt: s.occurredAt.toISOString(),
    }
  })
  return { messages: siblings.length + 1, earlier: lines }
})
