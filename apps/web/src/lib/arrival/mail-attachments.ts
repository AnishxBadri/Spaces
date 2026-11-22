import { createHash } from 'node:crypto'
import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { simpleParser } from 'mailparser'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  interactionDocument,
} from '@spaces/db/schema'
import { accessTokenFor } from '@spaces/core/writes/connections/token'
import { attachmentPointerOf } from './attachment-pointer'
import type { AttachmentPointer } from './attachment-pointer'

/**
 * A synced attachment's file, fetched back from the mailbox it came through
 *: the row keeps its text, chunks and vectors, and the bytes stay in
 * Gmail until a person keeps a copy.
 * - The fetch is the host's, under the connection's own token, with the
 *   `gmail.readonly` scope the syncer already holds: the message's raw bytes,
 *   and the part whose digest the row names.
 * - `MailAttachments` is the seam: extraction, the viewer's fetch and Keep a
 *   copy all ask it, and a test hands a stub.
 */

export class AttachmentUnavailable extends Schema.TaggedError<AttachmentUnavailable>()(
  'AttachmentUnavailable',
  {
    /** The sentence the viewer or the row shows. */
    reason: Schema.String,
    /** A transient failure: the provider or the network, worth another try. */
    retryable: Schema.Boolean,
  },
) {}

export type FetchedAttachment = {
  readonly content: Buffer
  readonly mime: string | null
}

export class MailAttachments extends Context.Service<
  MailAttachments,
  {
    readonly fetch: (input: {
      readonly connectionId: string
      readonly pointer: AttachmentPointer
    }) => Effect.Effect<FetchedAttachment, AttachmentUnavailable>
  }
>()('spaces/web/arrival/MailAttachments') {
  /** Gmail's REST API, under the connection's token. */
  static readonly layer = Layer.succeed(
    MailAttachments,
    MailAttachments.of({
      fetch: ({ connectionId, pointer }) =>
        fetchFromGmail(connectionId, pointer),
    }),
  )
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

/** A fetch of one message that takes longer than this is a failed one. */
const FETCH_TIMEOUT_MS = 60_000

const RECONNECT = 'Gmail refused the connection: reconnect it'

const rawMessage = Schema.Struct({ raw: Schema.NonEmptyString })

const unavailable = (reason: string, retryable: boolean) =>
  new AttachmentUnavailable({ reason, retryable })

const fetchFromGmail = Effect.fn('fetchFromGmail')(function* (
  connectionId: string,
  pointer: AttachmentPointer,
): Effect.fn.Return<FetchedAttachment, AttachmentUnavailable> {
  const token = yield* accessTokenFor(connectionId).pipe(
    Effect.mapError((e) =>
      e._tag === 'ProviderUnavailable'
        ? unavailable('Google could not be reached', true)
        : unavailable(RECONNECT, false),
    ),
  )
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(
        `${GMAIL_API}/users/me/messages/${encodeURIComponent(pointer.messageId)}?format=raw`,
        {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${Redacted.value(token)}`,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      ),
    catch: () => unavailable('Gmail could not be reached', true),
  })
  if (response.status === 404)
    return yield* unavailable('The email is no longer in Gmail', false)
  if (response.status === 401 || response.status === 403)
    return yield* unavailable(RECONNECT, false)
  if (response.status !== 200)
    return yield* unavailable(
      `Gmail answered ${String(response.status)}`,
      response.status === 429 || response.status >= 500,
    )
  const body = yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: () =>
      unavailable('Gmail sent a message this host cannot read', true),
  })
  const decoded = Schema.decodeUnknownOption(rawMessage)(body)
  if (Option.isNone(decoded))
    return yield* unavailable(
      'Gmail sent a message this host cannot read',
      false,
    )
  return yield* attachmentIn(
    Buffer.from(decoded.value.raw, 'base64url'),
    pointer.sha,
  )
})

/** The part of a raw message whose digest is `sha`. */
export const attachmentIn = Effect.fn('attachmentIn')(function* (
  raw: Buffer,
  sha: string,
): Effect.fn.Return<FetchedAttachment, AttachmentUnavailable> {
  const parsed = yield* Effect.tryPromise({
    try: () => simpleParser(raw),
    catch: () => unavailable('The email in Gmail could not be read', false),
  })
  const part = parsed.attachments.find(
    (a) => createHash('sha256').update(a.content).digest('hex') === sha,
  )
  if (part === undefined)
    return yield* unavailable(
      'The attachment is no longer in that email',
      false,
    )
  return {
    content: part.content,
    mime: part.contentType === '' ? null : part.contentType,
  }
})

export class MailAttachmentReadFailed extends Schema.TaggedError<MailAttachmentReadFailed>()(
  'MailAttachmentReadFailed',
  { cause: Schema.Defect() },
) {}

/** An attachment row whose file is in the mailbox, and where to fetch it. */
export type MailAttachmentTarget = {
  readonly _tag: 'target'
  readonly documentId: string
  readonly connectionId: string
  readonly pointer: AttachmentPointer
}

/** Why an attachment row's file cannot be fetched now. */
export type MailAttachmentRefusal =
  /** The row holds its bytes, or is not a mailbox's attachment. */
  | { readonly _tag: 'not-remote' }
  /** The mailbox was disconnected: only the text is kept. */
  | { readonly _tag: 'disconnected' }
  /** The connection is in error or revoked. */
  | { readonly _tag: 'connection'; readonly reason: string | null }

/** The sentence a refusal reads as. */
export function mailAttachmentRefusalMessage(
  refusal: Exclude<MailAttachmentRefusal, { _tag: 'not-remote' }>,
): string {
  return refusal._tag === 'disconnected'
    ? 'Gmail was disconnected; only this file’s text is kept here'
    : `Gmail cannot be reached: ${refusal.reason ?? 'the connection needs reconnecting'}`
}

/**
 * An email attachment with no bytes here: `blob_sha` empty, joined to its
 * email. The SQL twin of `mailAttachmentOf`'s first test, for list queries.
 */
export const remoteAttachmentSql = sql<boolean>`(${document.blobSha} is null and ${document.sourceClass} = 'integration' and exists (select 1 from ${interactionDocument} where ${interactionDocument.documentId} = ${document.entityId} and ${interactionDocument.role} = 'attachment'))`

/**
 * Such an attachment's reach, as every list reads it: `linked` opens
 * through Gmail and offers Keep a copy; `gone` is a disconnected mailbox,
 * its text alone left. Null on every row whose bytes are here, or that never
 * had any.
 */
export const remoteBytesSql = sql<
  'linked' | 'gone' | null
>`case when ${remoteAttachmentSql} then (case when ${document.externalStatus} = 'gone' or ${document.connectionId} is null then 'gone' else 'linked' end) end`

/** The row's pointer and its connection's health, read once. */
export const mailAttachmentOf = Effect.fn('mailAttachmentOf')(function* (
  documentId: string,
): Effect.fn.Return<
  MailAttachmentTarget | MailAttachmentRefusal,
  MailAttachmentReadFailed
> {
  const row = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          remote: remoteAttachmentSql,
          externalId: document.externalId,
          externalStatus: document.externalStatus,
          connectionId: document.connectionId,
          product: accountConnection.product,
          status: accountConnection.status,
          errorReason: accountConnection.errorReason,
        })
        .from(document)
        .leftJoin(
          accountConnection,
          eq(accountConnection.id, document.connectionId),
        )
        .where(eq(document.entityId, documentId))
        .then((rows) => rows.at(0)),
    catch: (cause) => new MailAttachmentReadFailed({ cause }),
  })
  if (row === undefined || !row.remote) return { _tag: 'not-remote' }
  const pointer = attachmentPointerOf(row.externalId)
  if (pointer === null) return { _tag: 'not-remote' }
  if (row.externalStatus === 'gone' || row.connectionId === null)
    return { _tag: 'disconnected' }
  if (row.product !== 'gmail') return { _tag: 'not-remote' }
  if (row.status !== 'active')
    return { _tag: 'connection', reason: row.errorReason }
  return {
    _tag: 'target',
    documentId,
    connectionId: row.connectionId,
    pointer,
  }
})
