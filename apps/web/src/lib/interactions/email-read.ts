import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { simpleParser } from 'mailparser'
import { normalizeEmail } from '@spaces/sdk/identity'
import { canRead } from '@spaces/core/read-policy'
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
}

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
          })
          .from(interactionDocument)
          .innerJoin(
            document,
            eq(document.entityId, interactionDocument.documentId),
          )
          .innerJoin(entity, eq(entity.id, interactionDocument.documentId))
          .leftJoin(integration, eq(integration.id, document.sourceRef))
          .where(
            and(
              eq(interactionDocument.interactionId, id),
              eq(interactionDocument.role, 'attachment'),
              canReadDocumentSql(viewer.id),
            ),
          )
          .orderBy(asc(entity.canonicalName))
          .then((rows) =>
            rows.map((r) => ({ ...r, filename: r.filename ?? r.name })),
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
  }
})
