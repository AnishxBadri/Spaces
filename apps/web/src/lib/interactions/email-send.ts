import { createHash, randomUUID } from 'node:crypto'
import { Context, Effect, Layer, Schema } from 'effect'
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { OUTGOING_EMAIL_LIMIT_BYTES, manifestSchema } from '@spaces/sdk'
import type { EmailAddress, OutgoingEmail } from '@spaces/sdk'
import {
  UnknownVariable,
  parseVariables,
  resolveVariables,
} from '@spaces/core/templates/variables'
import type { VariablePath } from '@spaces/core/templates/variables'
import { pluginQueueName } from '@spaces/core/queue/names'
import type { PluginQueueName } from '@spaces/core/queue/names'
import type { QueuedJob } from '@spaces/core/queue/sender'
import { hasScopes } from '@spaces/core/writes/connections/scopes'
import { storage } from '@spaces/core/writes/storage'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  emailDraft,
  integration,
  interaction,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type { DraftRecipient } from '@spaces/db/schema/drafts'
import { enqueue, jobsByKey } from '#/lib/queue'
import { runnable } from '#/lib/integrations/runnable'
import {
  DraftFailed,
  DraftNotFound,
  draftMessage,
  getDraftProgram,
} from './email-drafts'
import type { EmailDraft } from './email-drafts'
import { recipientContextsProgram } from './email-variables'

/**
 * Send: a draft handed to the Gmail plugin's `send` action and awaited.
 * - The sender is the viewer's Gmail connection bound to a running Gmail
 *   plugin — the parent's mailbox for a reply, else the earliest. Without
 *   `gmail.send` there is nothing to send with: the composer hides Send and
 *   names the account to reconnect (`emailSenderProgram`).
 * - Everything is checked before the call: recipients, every variable
 *   re-resolved here (never the client's text), files read through
 *   `canRead` and refused over 25 MB.
 * - A draft with variables is one message per To recipient, Cc and Bcc on
 *   each; without, one message to everyone.
 * - Each Message-ID is minted here from the draft and the recipient, so the
 *   outgoing row and a later sync dedupe on it and a second press after a
 *   failure never sends one already gone.
 * - The draft is deleted once every message is sent; any failure keeps it
 *   and says what Gmail said.
 */

export class SendRefused extends Schema.TaggedError<SendRefused>()(
  'SendRefused',
  { message: Schema.String },
) {}

export class AttachmentsTooLarge extends Schema.TaggedError<AttachmentsTooLarge>()(
  'AttachmentsTooLarge',
  {
    limitBytes: Schema.Number,
    totalBytes: Schema.Number,
    message: Schema.String,
  },
) {}

export class SendFailed extends Schema.TaggedError<SendFailed>()('SendFailed', {
  message: Schema.String,
}) {}

/** The sentence a client is shown. */
export function sendMessage(failure: unknown): string {
  if (
    failure instanceof SendRefused ||
    failure instanceof AttachmentsTooLarge ||
    failure instanceof SendFailed ||
    failure instanceof UnknownVariable
  )
    return failure.message
  if (failure instanceof DraftNotFound) return draftMessage(failure)
  return 'Could not send the email'
}

/** Whether the composer may send, and what to do when it may not. */
export type EmailSender =
  | { readonly _tag: 'ready'; readonly from: string }
  | {
      readonly _tag: 'reconnect'
      readonly from: string
      /** The account page that reconnects it. */
      readonly connectionId: string
    }
  | {
      readonly _tag: 'unavailable'
      readonly reason: string
      /** Where it is set up; null when an admin must act. */
      readonly href: string | null
    }

export type SendInput = {
  readonly draftId: string
  /** Review's fills, by recipient address, then by variable path. */
  readonly fills: {
    readonly [email: string]: { readonly [path: string]: string }
  }
  /** Recipients whose blanks go out empty. */
  readonly accepted: ReadonlyArray<string>
}

export type Sent = {
  /** Messages that left, this press and any earlier one. */
  readonly sent: number
  /** The outgoing rows written, in message order. */
  readonly interactionIds: ReadonlyArray<string>
}

/** How the send lane reaches the worker: a sender's enqueue and its status read. */
export class SendQueue extends Context.Service<
  SendQueue,
  {
    readonly enqueue: (
      queue: PluginQueueName,
      payload: OutgoingEmail,
      key: string,
    ) => Effect.Effect<string | null>
    readonly jobs: (
      queue: PluginQueueName,
      key: string,
    ) => Effect.Effect<ReadonlyArray<QueuedJob> | null>
  }
>()('spaces/web/SendQueue') {}

/** The web process's sender. */
const SendQueueLive: Layer.Layer<SendQueue> = Layer.succeed(
  SendQueue,
  SendQueue.of({
    enqueue: (queue, payload, key) =>
      Effect.promise(() => enqueue(queue, { payload }, { singletonKey: key })),
    jobs: (queue, key) => Effect.promise(() => jobsByKey(queue, key)),
  }),
)

/** How long a press waits for Gmail, and how often it looks. */
type SendTiming = { readonly waitMs: number; readonly pollMs: number }

const SEND_TIMING: SendTiming = { waitMs: 60_000, pollMs: 250 }

/** How long a file's URL lives: the job may wait behind another send. */
const FILE_URL_TTL_SECONDS = 15 * 60

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DraftFailed({ cause }) })

const MB = 1024 * 1024
const megabytes = (bytes: number) =>
  `${(Math.round((bytes / MB) * 10) / 10).toFixed(1)} MB`

type Sender = {
  readonly integrationId: string
  readonly connectionId: string
  readonly address: string
  readonly queue: PluginQueueName
  readonly canSend: boolean
}

const SEND_JOB = 'send'

/** The queue a stored Gmail manifest sends on; null when it has no send job. */
const sendQueueOf = (manifest: unknown): PluginQueueName | null => {
  const parsed = manifestSchema.safeParse(manifest)
  if (!parsed.success) return null
  const job = Object.hasOwn(parsed.data.jobs, SEND_JOB)
    ? parsed.data.jobs[SEND_JOB]
    : null
  if (job?.trigger !== 'action' || job.input !== 'payload') return null
  return pluginQueueName(parsed.data.id, SEND_JOB, job.interactive === true)
}

const CONNECT_GMAIL: EmailSender = {
  _tag: 'unavailable',
  reason: 'Connect Gmail to send',
  href: '/settings/email-calendar',
}

/**
 * The viewer's sending mailbox. `parentId` prefers the mailbox the parent
 * came through, so a reply goes out from the account it was sent to.
 */
const senderOf = Effect.fn('emailSender')(function* (
  viewerId: string,
  parentId: string | null,
): Effect.fn.Return<Sender | EmailSender, DraftFailed> {
  const rows = yield* query(() =>
    db
      .select({
        integrationId: integration.id,
        manifest: integration.manifest,
        connectionId: accountConnection.id,
        address: accountConnection.externalEmail,
        status: accountConnection.status,
      })
      .from(accountConnection)
      .innerJoin(
        integration,
        eq(integration.connectionId, accountConnection.id),
      )
      .where(
        and(
          eq(accountConnection.userId, viewerId),
          eq(accountConnection.product, 'gmail'),
          ne(accountConnection.status, 'revoked'),
          eq(integration.capabilityId, 'gmail'),
          isNull(integration.removedAt),
          runnable,
        ),
      )
      .orderBy(asc(accountConnection.createdAt)),
  )
  if (rows.length === 0) {
    const held = yield* query(() =>
      db
        .select({ id: accountConnection.id })
        .from(accountConnection)
        .where(
          and(
            eq(accountConnection.userId, viewerId),
            eq(accountConnection.product, 'gmail'),
            ne(accountConnection.status, 'revoked'),
          ),
        )
        .limit(1),
    )
    return held.length === 0
      ? CONNECT_GMAIL
      : {
          _tag: 'unavailable',
          reason: 'Gmail is not running, so it cannot send. Today says why',
          href: null,
        }
  }
  const parentRef =
    parentId === null
      ? null
      : ((yield* query(() =>
          db
            .select({ sourceRef: interaction.sourceRef })
            .from(interaction)
            .where(eq(interaction.id, parentId)),
        )).at(0)?.sourceRef ?? null)
  const row = rows.find((r) => r.integrationId === parentRef) ?? rows.at(0)
  if (row === undefined) return CONNECT_GMAIL
  const queue = sendQueueOf(row.manifest)
  if (queue === null)
    return {
      _tag: 'unavailable',
      reason: 'This Gmail plugin cannot send. Update it to send',
      href: null,
    }
  const check = yield* hasScopes(row.connectionId, ['gmail.send']).pipe(
    Effect.mapError((cause) => new DraftFailed({ cause })),
  )
  return {
    integrationId: row.integrationId,
    connectionId: row.connectionId,
    address: row.address,
    queue,
    canSend: check._tag === 'granted' && row.status === 'active',
  }
})

const isSender = (s: Sender | EmailSender): s is Sender => !('_tag' in s)

const asEmailSender = (s: Sender): EmailSender =>
  s.canSend
    ? { _tag: 'ready', from: s.address }
    : { _tag: 'reconnect', from: s.address, connectionId: s.connectionId }

/** The composer's read on open: Send, or the account to reconnect. */
export const emailSenderProgram = Effect.fn('emailSenderProgram')(function* (
  viewer: { id: string },
  parentId: string | null,
): Effect.fn.Return<EmailSender, DraftFailed> {
  const sender = yield* senderOf(viewer.id, parentId)
  return isSender(sender) ? asEmailSender(sender) : sender
})

const mailboxOf = (r: DraftRecipient): EmailAddress =>
  r.name === undefined ? { email: r.email } : { email: r.email, name: r.name }

/** A Message-ID for one message of this draft, stable across presses. */
export const mintMessageId = (
  draftId: string,
  recipient: string | null,
  address: string,
): string => {
  const domain = address.slice(address.lastIndexOf('@') + 1) || 'spaces.invalid'
  const who =
    recipient === null
      ? 'all'
      : createHash('sha256')
          .update(recipient.toLowerCase())
          .digest('hex')
          .slice(0, 12)
  return `spaces-${draftId}-${who}@${domain}`
}

type Message = {
  readonly messageId: string
  readonly to: ReadonlyArray<DraftRecipient>
  readonly subject: string
  readonly bodyMd: string
}

/**
 * The messages a draft is: one to everyone, or one per To recipient with
 * its variables resolved and Review's fills standing in for blanks.
 */
const messagesOf = Effect.fn('draftMessages')(function* (
  draft: EmailDraft,
  input: SendInput,
  address: string,
): Effect.fn.Return<
  Array<Message>,
  DraftFailed | UnknownVariable | SendRefused
> {
  const text = `${draft.subject}\n${draft.bodyMd}`
  if (parseVariables(text).length === 0)
    return [
      {
        messageId: mintMessageId(draft.id, null, address),
        to: draft.to,
        subject: draft.subject,
        bodyMd: draft.bodyMd,
      },
    ]
  if (draft.to.length === 0)
    return yield* new SendRefused({
      message: 'A draft with variables goes to each To recipient: add one',
    })
  const contexts = yield* recipientContextsProgram(text, draft.to)
  const out: Array<Message> = []
  for (const r of draft.to) {
    const typed = input.fills[r.email] ?? {}
    const fills: { [path: VariablePath]: string } = {}
    for (const [path, value] of Object.entries(typed))
      if (value.trim() !== '') fills[path] = value
    const ctx = contexts.contextOf(r)
    const subject = resolveVariables(draft.subject, ctx, fills)
    const body = resolveVariables(draft.bodyMd, ctx, fills)
    if (subject instanceof UnknownVariable) return yield* Effect.fail(subject)
    if (body instanceof UnknownVariable) return yield* Effect.fail(body)
    const open = [...new Set([...subject.blanks, ...body.blanks])].filter(
      (p) => !Object.hasOwn(fills, p),
    )
    const accepted = input.accepted.some(
      (e) => e.toLowerCase() === r.email.toLowerCase(),
    )
    if (open.length > 0 && !accepted)
      return yield* new SendRefused({
        message: `{{${open[0]}}} is blank for ${r.name ?? r.email}: fill it or leave it blank`,
      })
    out.push({
      messageId: mintMessageId(draft.id, r.email, address),
      to: [r],
      subject: subject.text,
      bodyMd: body.text,
    })
  }
  return out
})

/** The draft's files as the plugin reads them: URLs to the blob backend. */
const filesOf = Effect.fn('draftFiles')(function* (
  draft: EmailDraft,
): Effect.fn.Return<
  OutgoingEmail['attachments'],
  DraftFailed | SendRefused | AttachmentsTooLarge
> {
  if (draft.attachments.length === 0) return []
  const ids = draft.attachments.map((a) => a.documentId)
  const rows = yield* query(() =>
    db
      .select({
        id: document.entityId,
        filename: document.filename,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        blobSha: document.blobSha,
        bytesState: document.bytesState,
      })
      .from(document)
      .where(inArray(document.entityId, ids)),
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const named = draft.attachments.flatMap((a) => {
    const row = byId.get(a.documentId)
    return row === undefined ? [] : [{ ...row, name: a.name }]
  })
  const total = named.reduce((n, f) => n + (f.sizeBytes ?? 0), 0)
  if (total > OUTGOING_EMAIL_LIMIT_BYTES)
    return yield* new AttachmentsTooLarge({
      limitBytes: OUTGOING_EMAIL_LIMIT_BYTES,
      totalBytes: total,
      message: `The files come to ${megabytes(total)}; Gmail sends 25 MB at most`,
    })
  const out: Array<OutgoingEmail['attachments'][number]> = []
  for (const f of named) {
    const sha = f.blobSha
    if (sha === null || f.bytesState !== 'stored')
      return yield* new SendRefused({
        message: `${f.name} is not stored here, so it cannot be attached`,
      })
    const filename = f.filename ?? f.name
    const url = yield* query(() =>
      storage().getDownloadUrl(sha, FILE_URL_TTL_SECONDS, { filename }),
    )
    out.push({
      filename,
      mime: f.mime ?? 'application/octet-stream',
      url,
      sizeBytes: f.sizeBytes ?? 0,
    })
  }
  return out
})

/** The parent's threading headers: In-Reply-To, and References from the thread. */
const threadingOf = Effect.fn('draftThreading')(function* (
  parentId: string | null,
) {
  if (parentId === null) return { inReplyTo: null, references: [] }
  const parent = (yield* query(() =>
    db
      .select({
        messageId: interaction.messageId,
        threadId: interaction.threadId,
      })
      .from(interaction)
      .where(eq(interaction.id, parentId)),
  )).at(0)
  const id = parent?.messageId ?? null
  if (id === null) return { inReplyTo: null, references: [] }
  // The full chain is not stored; its root and the parent thread it.
  const root = parent?.threadId ?? null
  return {
    inReplyTo: id,
    references: root === null || root === id ? [id] : [root, id],
  }
})

/** What one job came to: still going, sent, or Gmail's reason. */
type Settled =
  | { readonly _tag: 'pending' }
  | { readonly _tag: 'sent' }
  | {
      readonly _tag: 'failed'
      readonly reason: string
    }

const reasonOf = (output: object | null): string | null => {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

const kindOf = (output: object | null): unknown =>
  output === null ? null : Reflect.get(output, 'kind')

/** The latest job under a key: a rate-limited one was re-sent and is still going. */
export function settledOf(jobs: ReadonlyArray<QueuedJob> | null): Settled {
  const latest = [...(jobs ?? [])]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)
  if (latest === undefined) return { _tag: 'pending' }
  if (latest.state === 'completed')
    return kindOf(latest.output) === 'rate-limited'
      ? { _tag: 'pending' }
      : { _tag: 'sent' }
  if (latest.state === 'failed' || latest.state === 'cancelled')
    return {
      _tag: 'failed',
      reason: reasonOf(latest.output) ?? 'Gmail could not send it',
    }
  return { _tag: 'pending' }
}

const heldIds = Effect.fn('heldMessageIds')(function* (
  messageIds: ReadonlyArray<string>,
) {
  const rows = yield* query(() =>
    db
      .select({ id: interaction.id, messageId: interaction.messageId })
      .from(interaction)
      .where(inArray(interaction.messageId, [...messageIds])),
  )
  return new Map(
    rows.flatMap((r) => (r.messageId === null ? [] : [[r.messageId, r.id]])),
  )
})

export const sendDraftProgram = Effect.fn('sendDraftProgram')(function* (
  viewer: { id: string },
  input: SendInput,
  timing: SendTiming = SEND_TIMING,
): Effect.fn.Return<
  Sent,
  | DraftFailed
  | DraftNotFound
  | UnknownVariable
  | SendRefused
  | AttachmentsTooLarge
  | SendFailed,
  SendQueue
> {
  const draft = yield* getDraftProgram(viewer, input.draftId)
  const sender = yield* senderOf(viewer.id, draft.inReplyToId)
  if (!isSender(sender))
    return yield* new SendRefused({
      message:
        sender._tag === 'unavailable'
          ? sender.reason
          : 'Reconnect Gmail to send',
    })
  if (!sender.canSend)
    return yield* new SendRefused({ message: 'Reconnect Gmail to send' })
  if (draft.to.length + draft.cc.length + draft.bcc.length === 0)
    return yield* new SendRefused({ message: 'Add a recipient' })

  const messages = yield* messagesOf(draft, input, sender.address)
  const attachments = yield* filesOf(draft)
  const threading = yield* threadingOf(draft.inReplyToId)
  const name = (yield* query(() =>
    db.select({ name: user.name }).from(user).where(eq(user.id, viewer.id)),
  )).at(0)?.name
  const from: EmailAddress =
    name === undefined || name.trim() === ''
      ? { email: sender.address }
      : { email: sender.address, name }

  // A message an earlier press already sent is not sent again.
  const before = yield* heldIds(messages.map((m) => m.messageId))
  const queue = yield* SendQueue
  const waiting: Array<{ key: string; message: Message }> = []
  for (const message of messages) {
    if (before.has(message.messageId)) continue
    const payload: OutgoingEmail = {
      messageId: message.messageId,
      from,
      to: message.to.map(mailboxOf),
      cc: draft.cc.map(mailboxOf),
      bcc: draft.bcc.map(mailboxOf),
      subject: message.subject,
      bodyMd: message.bodyMd,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      attachments,
    }
    const key = randomUUID()
    const id = yield* queue.enqueue(sender.queue, payload, key)
    if (id === null)
      return yield* new SendFailed({
        message: 'The send queue is unreachable. The draft is kept',
      })
    waiting.push({ key, message })
  }

  const failures: Array<string> = []
  let open = waiting
  const until = Date.now() + timing.waitMs
  while (open.length > 0 && Date.now() < until) {
    const still: typeof open = []
    for (const w of open) {
      const settled = settledOf(yield* queue.jobs(sender.queue, w.key))
      if (settled._tag === 'pending') still.push(w)
      if (settled._tag === 'failed') failures.push(settled.reason)
    }
    open = still
    if (open.length > 0) yield* Effect.sleep(timing.pollMs)
  }

  const held = yield* heldIds(messages.map((m) => m.messageId))
  const sent = messages.length - failures.length - open.length
  if (failures.length > 0 || open.length > 0) {
    const reason =
      failures.at(0) ??
      'Gmail has not answered yet; a second press will not send it twice'
    return yield* new SendFailed({
      message:
        messages.length > 1 && sent > 0
          ? `Sent ${String(sent)} of ${String(messages.length)}. ${reason}. The draft is kept`
          : `${reason}. The draft is kept`,
    })
  }
  yield* query(() =>
    db
      .delete(emailDraft)
      .where(
        and(eq(emailDraft.id, draft.id), eq(emailDraft.userId, viewer.id)),
      ),
  )
  return {
    sent: messages.length,
    interactionIds: messages.flatMap((m) => held.get(m.messageId) ?? []),
  }
})

/** `sendDraftProgram` on the web process's sender: what the server fn runs. */
export const sendDraftLive = (viewer: { id: string }, input: SendInput) =>
  sendDraftProgram(viewer, input).pipe(Effect.provide(SendQueueLive))
