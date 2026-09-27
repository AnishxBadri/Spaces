import { createHash } from 'node:crypto'
import { simpleParser } from 'mailparser'
import type { AddressObject, ParsedMail } from 'mailparser'
import {
  messageIdList,
  normalizeMessageId,
  parseForwarded,
  threadRoot,
} from './forwarded'
import type { Address, ForwardedBlock } from './forwarded'
import { refusal } from './noise'
import type { Refusal } from './noise'

/**
 * One fetched message → what the poll writes, or why it writes nothing
 * (SPA-56). No database and no network: `mailparser` turns the bytes into
 * headers and text, and everything after that is a pure function of them, so
 * the forward fixtures and the noise table are asserted with no Postgres.
 *
 * The shape is the interaction's, not the message's. On a BCC the message is
 * the conversation, headers and all. On a **true forward** (D49) the message
 * is a wrapper — from the forwarder, no References, the original's headers
 * printed at the top of the body — so the sender, the participants, the date,
 * the subject and the thread all come out of the Forwarded-message block.
 *
 * The dedupe key is the RFC Message-ID (`interaction_message_id_unique`), and
 * a forward is where that needs a second thought: two presses of Forward mint
 * two wrapper Message-IDs for one original. So a forward is keyed on the
 * original — its own Message-ID when the block prints one, else an id derived
 * from the original's sender, date and subject (`derivedMessageId`), which is
 * what makes "forward it again" and "my partner forwarded it too" land on the
 * row already written.
 */

export type ArrivalMessage = {
  /** Stored without angle brackets; the dedupe key. */
  messageId: string
  threadId: string
  subject: string | null
  occurredAt: Date
  /** The conversation's sender — the original's on a true forward. */
  from: Address | null
  /** Who forwarded it, on a true forward; null for a BCC. */
  forwarder: Address | null
  /** Sender, To and Cc, deduped, the mailbox itself left out. */
  participants: Array<Address>
  /** The plain-text body, stored as the interaction's note (D30). */
  body: string
  forwarded: boolean
}

export type Arrival =
  | { kind: 'message'; message: ArrivalMessage }
  | { kind: 'refused'; refusal: Refusal; messageId: string | null }

export type ArrivalOptions = {
  /** The mailbox's own address, never a participant. */
  mailboxAddress: string
  /** When the message has no readable date at all. */
  receivedAt: Date
}

const FORWARD_SUBJECT = /^\s*(?:fwd?|fw)\s*:/i

/** Parse the raw bytes, then `toArrival`. */
export async function arrivalFromSource(
  source: Buffer | string,
  opts: ArrivalOptions,
): Promise<Arrival> {
  const parsed = await simpleParser(source, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  })
  return toArrival(parsed, opts)
}

export function toArrival(parsed: ParsedMail, opts: ArrivalOptions): Arrival {
  const ownId = normalizeMessageId(parsed.messageId)
  const references = referencesOf(parsed.references)
  const inReplyTo = normalizeMessageId(
    parsed.inReplyTo === undefined
      ? null
      : messageIdList(parsed.inReplyTo).at(0),
  )
  const text = parsed.text ?? ''
  const outerFrom = addresses(parsed.from).at(0) ?? null

  const block = parseForwarded(text)
  const isForward =
    block !== null &&
    ((references.length === 0 && inReplyTo === null) ||
      FORWARD_SUBJECT.test(parsed.subject ?? ''))
  const original: ForwardedBlock | null = isForward ? block : null

  const sender = original?.from ?? outerFrom
  const subject =
    original?.subject ??
    (original === null
      ? (parsed.subject ?? null)
      : (parsed.subject?.replace(FORWARD_SUBJECT, '').trim() ?? null))

  const refused = refusal({
    messageId: ownId,
    autoSubmitted: rawHeader(parsed, 'auto-submitted'),
    xAutoreply:
      rawHeader(parsed, 'x-autoreply') !== null ||
      rawHeader(parsed, 'x-autorespond') !== null,
    listUnsubscribe: rawHeader(parsed, 'list-unsubscribe') !== null,
    precedence: rawHeader(parsed, 'precedence'),
    sender: sender?.email ?? null,
    subject,
  })
  if (refused !== null)
    return { kind: 'refused', refusal: refused, messageId: ownId }
  // `refusal` already said no to a missing id; this narrows it for the type.
  if (ownId === null)
    return {
      kind: 'refused',
      refusal: { reason: 'no-message-id', detail: 'no Message-ID header' },
      messageId: null,
    }

  const mailbox = opts.mailboxAddress.trim().toLowerCase()
  const participants = dedupe(
    original !== null
      ? [original.from, ...original.to, ...original.cc]
      : [outerFrom, ...addresses(parsed.to), ...addresses(parsed.cc)],
  ).filter((a) => a.email !== mailbox)

  if (original === null) {
    return {
      kind: 'message',
      message: {
        messageId: ownId,
        threadId: threadRoot({ references, inReplyTo, messageId: ownId }),
        subject,
        occurredAt: parsed.date ?? opts.receivedAt,
        from: outerFrom,
        forwarder: null,
        participants,
        body: text.trim(),
        forwarded: false,
      },
    }
  }

  const messageId =
    original.messageId ?? derivedMessageId(original, subject, text, ownId)
  return {
    kind: 'message',
    message: {
      messageId,
      threadId: threadRoot({
        references: original.references,
        inReplyTo: original.inReplyTo,
        messageId,
      }),
      subject,
      occurredAt: original.date ?? parsed.date ?? opts.receivedAt,
      from: original.from,
      forwarder: outerFrom,
      participants,
      body: text.trim(),
      forwarded: true,
    },
  }
}

/**
 * A stable id for an original whose block printed none: the same original
 * forwarded twice, or by two partners, hashes alike. The `.invalid` TLD (RFC
 * 2606) says in the column itself that no mail server minted it. Without a
 * date line the body after the block joins the hash, so two different mails
 * from one sender under one subject stay two rows.
 */
export function derivedMessageId(
  original: ForwardedBlock,
  subject: string | null,
  text: string,
  wrapperId: string,
): string {
  if (original.from === null) return wrapperId
  const parts = [
    original.from.email,
    original.date?.toISOString() ?? '',
    (subject ?? '').replace(/\s+/g, ' ').trim().toLowerCase(),
  ]
  if (original.date === null) parts.push(text.replace(/\s+/g, ' ').trim())
  const hash = createHash('sha256').update(parts.join('\n')).digest('hex')
  return `fwd-${hash.slice(0, 40)}@forwarded.invalid`
}

function referencesOf(raw: ParsedMail['references']): Array<string> {
  if (raw === undefined) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.flatMap((r) => messageIdList(r))
}

function addresses(
  field: AddressObject | Array<AddressObject> | undefined,
): Array<Address> {
  if (field === undefined) return []
  const objects = Array.isArray(field) ? field : [field]
  return objects.flatMap((o) =>
    o.value.flatMap((a) => {
      const members = a.group ?? [a]
      return members.flatMap((m) =>
        m.address === undefined || m.address === ''
          ? []
          : [{ email: m.address.toLowerCase(), name: m.name || null }],
      )
    }),
  )
}

function dedupe(list: ReadonlyArray<Address | null>): Array<Address> {
  const seen = new Set<string>()
  const out: Array<Address> = []
  for (const a of list) {
    if (a === null || seen.has(a.email)) continue
    seen.add(a.email)
    out.push(a)
  }
  return out
}

/** A header's raw value, by lowercase name; null when absent. */
function rawHeader(parsed: ParsedMail, name: string): string | null {
  const line = parsed.headerLines.find((h) => h.key === name)
  if (line === undefined) return null
  const colon = line.line.indexOf(':')
  return colon < 0 ? '' : line.line.slice(colon + 1).trim()
}
