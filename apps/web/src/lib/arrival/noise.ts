import type { ParticipantDecision } from './participants'

/**
 * The arrival lane's noise judgement (SPA-56), pure: which mail is refused
 * before anything is written. Pure and on its own because the calendar lane
 * needs exactly the same judgement over invitations, and because a refusal is
 * the one decision in the poll that has to be provable without a database —
 * `noise.test.ts` is a fixture table.
 *
 * Four refusals from `refusal`, in the order they are checked, and a fifth,
 * `excluded`, from `mailExclusion` for a connected mailbox's exclude list:
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
  'no-message-id' | 'auto-submitted' | 'list-mail' | 'role-sender' | 'excluded'

export const NOISE_REASONS: ReadonlyArray<NoiseReason> = [
  'no-message-id',
  'auto-submitted',
  'list-mail',
  'role-sender',
  'excluded',
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

/**
 * The calendar's refusals: which events are not meetings the workspace keeps.
 * Checked in this order, and only before a meeting is first written — one
 * already held follows its event, a cancellation included (D68).
 *
 * - **cancelled** — an event cancelled before it was ever seen did not happen.
 * - **declined** — the calendar's owner said no; it is not their meeting.
 * - **internal** — no attendee from outside: every one is a member, at an
 *   own domain, or a machine. The participants module decides who is
 *   outside, so this rule and the mail lane cannot disagree about a person.
 */

export type MeetingNoiseReason = 'cancelled' | 'declined' | 'internal'

export type MeetingNoiseInput = {
  status: 'scheduled' | 'cancelled'
  /** The owner's own answer; null when the owner is not on the list. */
  selfRsvp: 'accepted' | 'declined' | 'tentative' | 'needs_action' | null
  /** `decideParticipants` over the organizer and every attendee. */
  decisions: ReadonlyArray<Pick<ParticipantDecision, 'action'>>
}

export type MeetingRefusal = { reason: MeetingNoiseReason; detail: string }

/** The refusal for a calendar event, or null when it is a meeting to keep. */
export function meetingRefusal(
  input: MeetingNoiseInput,
): MeetingRefusal | null {
  if (input.status === 'cancelled')
    return { reason: 'cancelled', detail: 'cancelled before it was synced' }
  if (input.selfRsvp === 'declined')
    return { reason: 'declined', detail: 'declined by the calendar owner' }
  if (!input.decisions.some((d) => d.action === 'create'))
    return { reason: 'internal', detail: 'no attendee from outside' }
  return null
}

/**
 * A connected mailbox's exclude list: mail never synced. Checked before a
 * body is stored, and again over what is already held when the list grows.
 * - A sender entry is a domain (`acme.example`, its subdomains too), an
 *   address, or a local part ending in `@` (`noreply@`). Domains and
 *   addresses match any participant; a local part matches the sender only,
 *   since a person may copy a `notifications@` address on a real thread.
 * - A label entry matches a label name case-insensitively (`Promotions`).
 * - `DEFAULT_MAIL_EXCLUDE` ships with the plugin's settings; the Gmail
 *   manifest's defaults are asserted equal to it.
 */
export type MailExclude = {
  senders: ReadonlyArray<string>
  labels: ReadonlyArray<string>
}

export const DEFAULT_MAIL_EXCLUDE: MailExclude = {
  labels: ['Promotions', 'Social', 'Updates', 'Forums', 'Spam'],
  senders: [
    'noreply@',
    'no-reply@',
    'notifications@',
    'mailer-daemon@',
    'calendar-notification@google.com',
    'mcsv.net',
    'mcdlv.net',
    'rsgsv.net',
    'mandrillapp.com',
    'sendgrid.net',
    'amazonses.com',
    'mailgun.org',
    'sparkpostmail.com',
  ],
}

const DOMAIN_ENTRY = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/
const LOCAL_ENTRY = /^[a-z0-9._%+-]+@$/
const ADDRESS_ENTRY = /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}$/

/** One sender entry as stored — lowercased, a leading `@` dropped — or null when it is none of the three. */
export function senderEntry(raw: string): string | null {
  const entry = raw
    .trim()
    .toLowerCase()
    .replace(/^@(?=[^@]+$)/, '')
  if (
    DOMAIN_ENTRY.test(entry) ||
    LOCAL_ENTRY.test(entry) ||
    ADDRESS_ENTRY.test(entry)
  )
    return entry
  return null
}

export type MailExcludeInput = {
  /** The effective sender's address. */
  sender: string | null
  /** Every address on the message: sender, To and Cc. */
  participants: ReadonlyArray<string>
  labels: ReadonlyArray<string>
}

const domainOf = (address: string): string =>
  address
    .slice(address.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase()

const localOf = (address: string): string =>
  address.slice(0, address.lastIndexOf('@')).trim().toLowerCase().split('+')[0]

function senderMatch(entry: string, input: MailExcludeInput): string | null {
  if (entry.endsWith('@')) {
    const sender = input.sender
    return sender !== null && `${localOf(sender)}@` === entry ? sender : null
  }
  const everyone = [
    ...(input.sender === null ? [] : [input.sender]),
    ...input.participants,
  ].map((a) => a.trim().toLowerCase())
  if (entry.includes('@')) return everyone.find((a) => a === entry) ?? null
  return (
    everyone.find((a) => {
      const domain = domainOf(a)
      return domain === entry || domain.endsWith(`.${entry}`)
    }) ?? null
  )
}

/** The `excluded` refusal for a synced message, or null when the list names nothing on it. */
export function mailExclusion(
  input: MailExcludeInput,
  exclude: MailExclude,
): Refusal | null {
  const labels = new Set(input.labels.map((l) => l.trim().toLowerCase()))
  const label = exclude.labels.find((l) => labels.has(l.trim().toLowerCase()))
  if (label !== undefined)
    return { reason: 'excluded', detail: `label ${label} is excluded` }
  for (const raw of exclude.senders) {
    const entry = senderEntry(raw)
    if (entry === null) continue
    const hit = senderMatch(entry, input)
    if (hit !== null)
      return { reason: 'excluded', detail: `${hit} matches ${entry}` }
  }
  return null
}
