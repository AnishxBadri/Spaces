/**
 * The arrival lane's noise judgement (SPA-56), pure: which mail is refused
 * before anything is written. Pure and on its own because the calendar lane
 * needs exactly the same judgement over invitations, and because a refusal is
 * the one decision in the poll that has to be provable without a database —
 * `noise.test.ts` is a fixture table.
 *
 * Four refusals, and the order is the order they are checked:
 *
 * - **no Message-ID** — the dedupe key is the RFC Message-ID (CONTEXT.md
 *   "Email / calendar ingestion"). A message without one cannot be written
 *   idempotently, so it is not written at all.
 * - **auto-submitted** — `Auto-Submitted` with any value but `no` (RFC 3834),
 *   and the older `X-Autoreply` / `X-Autorespond` spellings. A forwarded
 *   out-of-office has lost its headers by the time it is forwarded, so its
 *   subject is read too: `Automatic reply:`, `Auto-reply:`, `Out of office`.
 * - **list mail** — a `List-Unsubscribe` header, or `Precedence: bulk | list
 *   | junk`. A newsletter is signal for a later lane, never a conversation.
 * - **role sender** — mail *from* a machine: `noreply@`, `mailer-daemon@`,
 *   `notifications@`, `calendar-notification@`, and the rest of `ROLE_SENDERS`.
 *   Deliberately not `isRoleEmail` from `@spaces/core/entities/normalize`:
 *   that list answers "does this address identify a person", and `hello@` or
 *   `founders@` fails it while being exactly the address a founder writes a
 *   fund from. This list answers "can a human have written this".
 *
 * On a true forward the sender that counts is the original's, not the
 * forwarder's — forwarding a `noreply@` notification is still a notification.
 */

export type NoiseReason =
  'no-message-id' | 'auto-submitted' | 'list-mail' | 'role-sender'

export const NOISE_REASONS: ReadonlyArray<NoiseReason> = [
  'no-message-id',
  'auto-submitted',
  'list-mail',
  'role-sender',
]

export type NoiseInput = {
  /** The message's own Message-ID header, or null when it has none. */
  messageId: string | null
  /** Header values, lowercase names, null when absent. */
  autoSubmitted: string | null
  xAutoreply: boolean
  listUnsubscribe: boolean
  precedence: string | null
  /** The effective sender's address: the original's on a true forward. */
  sender: string | null
  /** The effective subject: the original's on a true forward. */
  subject: string | null
}

export type Refusal = { reason: NoiseReason; detail: string }

/** Local parts no person writes from. Matched before any `+tag`. */
export const ROLE_SENDERS: ReadonlySet<string> = new Set([
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'notification',
  'notifications',
  'notify',
  'alert',
  'alerts',
  'newsletter',
  'newsletters',
  'digest',
  'updates',
  'calendar-notification',
  'calendar-server',
  'automated',
  'auto-confirm',
  'receipts',
  'invoice',
  'invoices',
])

const AUTO_REPLY_SUBJECT =
  /^\s*(?:automatic reply|auto(?:matic)?[- ]?reply|autoreply|out of (?:the )?office|ooo)\b/i

const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk'])

export function isRoleSender(address: string): boolean {
  const at = address.lastIndexOf('@')
  if (at <= 0) return false
  const local = address.slice(0, at).trim().toLowerCase().split('+')[0]
  return ROLE_SENDERS.has(local)
}

/** The refusal for a message, or null when it may be written. */
export function refusal(input: NoiseInput): Refusal | null {
  if (input.messageId === null || input.messageId.trim() === '')
    return { reason: 'no-message-id', detail: 'no Message-ID header' }

  const auto = input.autoSubmitted?.trim().toLowerCase() ?? null
  if (auto !== null && auto !== '' && auto !== 'no')
    return { reason: 'auto-submitted', detail: `Auto-Submitted: ${auto}` }
  if (input.xAutoreply)
    return { reason: 'auto-submitted', detail: 'X-Autoreply header' }
  if (input.subject !== null && AUTO_REPLY_SUBJECT.test(input.subject))
    return {
      reason: 'auto-submitted',
      detail: `auto-reply subject: ${input.subject.trim().slice(0, 80)}`,
    }

  if (input.listUnsubscribe)
    return { reason: 'list-mail', detail: 'List-Unsubscribe header' }
  const precedence = input.precedence?.trim().toLowerCase() ?? null
  if (precedence !== null && BULK_PRECEDENCE.has(precedence))
    return { reason: 'list-mail', detail: `Precedence: ${precedence}` }

  if (input.sender !== null && isRoleSender(input.sender))
    return {
      reason: 'role-sender',
      detail: `sent by ${input.sender.trim().toLowerCase()}`,
    }

  return null
}
