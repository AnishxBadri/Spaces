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
  accountConnection,
  document,
  entity,
  entityAlias,
  integration,
  interaction,
  interactionDocument,
  interactionEntity,
  note,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { remoteBytesSql } from '#/lib/arrival/mail-attachments'
import type { RemoteBytes } from '#/lib/documents/files-tab'
import { sanitizeEmailHtml } from '#/lib/email/sanitize'
import { viewerSelf } from '#/lib/timeline/record'
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
  /** One of the reader's own addresses: the line prints it as `you`. */
  you: boolean
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
  /** A file that stays in the mailbox: opened through Gmail, or gone with it. */
  remoteBytes: RemoteBytes
}

/** An earlier message of the thread, as its folded card prints it. */
export type EmailThreadLine = {
  id: string
  from: EmailParticipant | null
  to: Array<EmailParticipant>
  cc: Array<EmailParticipant>
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
  /** The folded card's line, as an earlier message's; null when the body is not the reader's. */
  preview: string | null
  body: EmailBody
  attachments: Array<EmailAttachment>
  /** Who reads a body private by default; null for a shared one. */
  privacy: EmailPrivacy | null
  /** The classify lane's labels; empty while the body is not the reader's. */
  categories: Array<EmailCategory>
  thread: EmailThread
  /**
   * The record the window was opened from, by name: whose files a reply
   * attaches. `linked` when the email is filed on it by its own edge, so
   * the window can unlink it there.
   */
  record: { id: string; name: string; linked: boolean } | null
  /** The message in Gmail, for an email that came through Gmail. */
  gmailUrl: string | null
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
    ...new Set(
      emails
        .map((e) => normalizeEmail(bareAddress(e)))
        .filter((e) => e !== null),
    ),
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
        messageId: interaction.messageId,
        lane: integration.capabilityId,
        mailbox: accountConnection.externalEmail,
        bodyMd: note.bodyMd,
        visibility: note.visibility,
        authorId: note.authorId,
        widened: noteWidenedSql(viewer.id),
        authorName: user.name,
      })
      .from(interaction)
      .leftJoin(note, eq(note.entityId, interaction.noteId))
      .leftJoin(user, eq(user.id, note.authorId))
      .leftJoin(integration, eq(integration.id, interaction.sourceRef))
      .leftJoin(
        accountConnection,
        eq(accountConnection.id, integration.connectionId),
      )
      .where(and(eq(interaction.id, id), eq(interaction.kind, 'email'))),
  )).at(0)
  if (!row) return yield* new EmailNotFound({ id })

  const meta = row.meta?.kind === 'email' ? row.meta : null
  // A Bcc is the sending mailbox's own: nobody else sees it.
  const bcc = row.authorId === viewer.id ? (meta?.bcc ?? []) : []
  const to = withMailbox(meta, row.mailbox)
  const found = yield* namesOf([
    ...(meta?.from ? [meta.from] : []),
    ...to,
    ...(meta?.cc ?? []),
    ...bcc,
  ])
  const names = mailboxNamed(found, row.mailbox, row.authorName)
  const own = yield* viewerSelf(viewer.id).pipe(
    Effect.mapError((cause) => new EmailReadFailed({ cause })),
  )
  const participant = participantOf(names, own.addresses)

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
            remoteBytes: remoteBytesSql,
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

  const thread = yield* threadOf(viewer, row, names, own.addresses)
  const listing = emailListing(row.meta, readable)
  const record =
    recordId === null
      ? undefined
      : (yield* query(() =>
          db
            .select({ id: entity.id, name: entity.canonicalName })
            .from(entity)
            .where(and(eq(entity.id, recordId), isNull(entity.mergedIntoId))),
        )).at(0)
  const linked =
    record === undefined
      ? false
      : (yield* query(() =>
          db
            .select({ id: interactionEntity.entityId })
            .from(interactionEntity)
            .where(
              and(
                eq(interactionEntity.interactionId, id),
                eq(interactionEntity.entityId, record.id),
              ),
            ),
        )).length > 0

  return {
    id: row.id,
    subject: row.subject,
    occurredAt: row.occurredAt.toISOString(),
    from: meta?.from ? participant(meta.from) : null,
    to: to.map(participant),
    cc: (meta?.cc ?? []).map(participant),
    bcc: bcc.map(participant),
    via: row.authorName,
    preview: readable
      ? clean(
          listing.summary ?? listing.snippet ?? row.bodyMd ?? undefined,
          PREVIEW_MAX,
        )
      : null,
    body,
    attachments,
    privacy,
    categories: listing.categories,
    thread,
    record: record === undefined ? null : { ...record, linked },
    gmailUrl: row.lane === 'gmail' ? gmailUrl(row.messageId) : null,
  }
})

/**
 * The message in the reader's Gmail, found by its Message-ID: the one key
 * every mailbox that holds it shares. Null without one.
 */
export function gmailUrl(messageId: string | null): string | null {
  const bare = messageId?.trim().replace(/^<|>$/g, '') ?? ''
  if (bare === '') return null
  return `https://mail.google.com/mail/#search/rfc822msgid%3A${encodeURIComponent(bare)}`
}

/**
 * An address as a card's line prints it: its person's name when it is a
 * known alias, and `you` when it is one of the reader's own.
 */
const participantOf =
  (names: ReadonlyMap<string, string>, self: ReadonlySet<string>) =>
  (email: string): EmailParticipant => {
    const key = normalizeEmail(bareAddress(email)) ?? ''
    return { email, name: names.get(key) ?? null, you: self.has(key) }
  }

/**
 * To, with the synced mailbox's own address put back first: arrival drops
 * it from To and Cc, so a message in the reader's mailbox would otherwise
 * never read `→ you`. Not for mail sent from the mailbox, nor when the
 * address is still on the message; a forwarded message has no mailbox here.
 */
function withMailbox(
  meta: { from: string; to: Array<string>; cc: Array<string> } | null,
  mailbox: string | null,
): Array<string> {
  const to = meta?.to ?? []
  if (meta === null || mailbox === null) return to
  const key = normalizeEmail(mailbox)
  const on = [meta.from, ...meta.to, ...meta.cc].some(
    (a) => normalizeEmail(bareAddress(a)) === key,
  )
  return key === null || on ? to : [mailbox, ...to]
}

/** The names, with the mailbox's address named for its member when no person holds it. */
function mailboxNamed(
  names: ReadonlyMap<string, string>,
  mailbox: string | null,
  owner: string | null,
): ReadonlyMap<string, string> {
  const key = mailbox === null ? null : normalizeEmail(mailbox)
  if (key === null || owner === null || names.has(key)) return names
  return new Map([...names, [key, owner]])
}

/** The address inside a header value: `Ana <ana@x.com>` → `ana@x.com`. */
function bareAddress(header: string): string {
  const angled = /<([^>]+)>/.exec(header)
  return (angled?.[1] ?? header).trim()
}

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
  self: ReadonlySet<string>,
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
        mailbox: accountConnection.externalEmail,
        bodyMd: note.bodyMd,
        visibility: note.visibility,
        authorId: note.authorId,
        authorName: user.name,
        widened: noteWidenedSql(viewer.id),
        attachments: sql<number>`(
          select count(*)::int from ${interactionDocument}
          where ${interactionDocument.interactionId} = ${interaction.id}
            and ${interactionDocument.role} = 'attachment'
        )`,
      })
      .from(interaction)
      .leftJoin(note, eq(note.entityId, interaction.noteId))
      .leftJoin(user, eq(user.id, note.authorId))
      .leftJoin(integration, eq(integration.id, interaction.sourceRef))
      .leftJoin(
        accountConnection,
        eq(accountConnection.id, integration.connectionId),
      )
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
  const earlier = siblings.filter((s) => s.occurredAt <= row.occurredAt)
  const metas = earlier.map((s) => (s.meta?.kind === 'email' ? s.meta : null))
  const tos = earlier.map((s, i) => withMailbox(metas.at(i) ?? null, s.mailbox))
  const more = yield* namesOf(
    metas.flatMap((m, i) =>
      m === null ? [] : [m.from, ...(tos.at(i) ?? []), ...m.cc],
    ),
  )
  const lines = earlier.map((s, i): EmailThreadLine => {
    const meta = metas.at(i) ?? null
    const participant = participantOf(
      mailboxNamed(new Map([...more, ...known]), s.mailbox, s.authorName),
      self,
    )
    const readable = canRead(viewer, {
      visibility: s.visibility,
      authorId: s.authorId,
      widened: s.widened,
    })
    const listing = emailListing(s.meta, readable)
    return {
      id: s.id,
      from: meta?.from ? participant(meta.from) : null,
      to: (tos.at(i) ?? []).map(participant),
      cc: (meta?.cc ?? []).map(participant),
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
