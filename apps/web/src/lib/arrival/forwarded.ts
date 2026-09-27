/**
 * The Forwarded-message block (SPA-56, D49), pure. A BCC carries its own
 * headers; a true forward is a new message *from the forwarder*, with no
 * References, and the original's sender, recipients and date survive only as
 * text at the top of the quoted body. Matching the forwarder instead of the
 * original is how "forward me the founder's email" — the most common use of
 * the lane — would match nothing, so the block is read and its headers are
 * what the poll matches.
 *
 * The three shapes the fixtures carry, which between them are nearly every
 * forward a fund will send:
 *
 *     ---------- Forwarded message ---------          (Gmail)
 *     From: Jane Founder <jane@acme.io>
 *     Date: Mon, Sep 21, 2026 at 10:04 AM
 *     Subject: Seed round
 *     To: Anish <anish@fund.example>
 *
 *     ________________________________                (Outlook; also
 *     From: Jane Founder <jane@acme.io>                 -----Original Message-----)
 *     Sent: Monday, September 21, 2026 10:04 AM
 *     To: Anish <anish@fund.example>
 *     Subject: Seed round
 *
 *     Begin forwarded message:                        (Apple Mail)
 *
 *     From: Jane Founder <jane@acme.io>
 *     Subject: Seed round
 *     Date: 21 September 2026 at 10:04:00 BST
 *     To: Anish <anish@fund.example>
 *
 * Header lines may be quoted (`> From:`), starred by a rich-text-to-plain
 * conversion (`*From:*`), or folded onto a following indented line. A block
 * that also carries `Message-ID`, `In-Reply-To` or `References` lines (Apple
 * Mail can, and so can a forward-as-text of raw headers) gives the thread its
 * real identity; one that does not is threaded on its own derived id.
 */

export type Address = { email: string; name: string | null }

export type ForwardedBlock = {
  from: Address | null
  to: Array<Address>
  cc: Array<Address>
  /** Null when the block's date line is absent or unreadable. */
  date: Date | null
  subject: string | null
  messageId: string | null
  inReplyTo: string | null
  references: Array<string>
}

const MARKERS: ReadonlyArray<RegExp> = [
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^begin forwarded message:?$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^_{10,}$/,
]

const HEADER = /^\*{0,2}([A-Za-z-]+)\*{0,2}:\*{0,2}\s*(.*)$/

const KNOWN = new Set([
  'from',
  'to',
  'cc',
  'date',
  'sent',
  'subject',
  'message-id',
  'in-reply-to',
  'references',
  'reply-to',
])

const EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi

/** `<abc@x>` → `abc@x`; the form every `message_id` / `thread_id` is stored in. */
export function normalizeMessageId(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim().replace(/^<+/, '').replace(/>+$/, '').trim()
  return trimmed === '' ? null : trimmed
}

/** Every `<id>` in a References-shaped string, in order. */
export function messageIdList(raw: string): Array<string> {
  const bracketed = [...raw.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1])
  if (bracketed.length > 0) return bracketed
  return raw
    .split(/\s+/)
    .map((s) => normalizeMessageId(s))
    .filter((s): s is string => s !== null)
}

/**
 * The thread a message belongs to: the root of its References chain, else
 * what it replies to, else itself. References lists oldest first (RFC 5322
 * §3.6.4), so its first entry is the thread's first message.
 */
export function threadRoot(ids: {
  references: ReadonlyArray<string>
  inReplyTo: string | null
  messageId: string
}): string {
  return ids.references.at(0) ?? ids.inReplyTo ?? ids.messageId
}

/**
 * `Jane Founder <jane@acme.io>, "Doe, John" <john@x.io>; bob@y.io` — every
 * address on a header line, with the display name in front of it when there
 * is one. Outlook's `Jane [mailto:jane@acme.io]` reads the same.
 */
export function parseAddresses(line: string): Array<Address> {
  const out: Array<Address> = []
  const seen = new Set<string>()
  let last = 0
  for (const m of line.matchAll(EMAIL)) {
    const email = m[0].toLowerCase()
    const index = m.index
    const before = line
      .slice(last, index)
      .replace(/^[\s,;>\]]+/, '')
      .replace(/[<[(]\s*(?:mailto:)?\s*$/i, '')
      .replace(/^["']|["']$/g, '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim()
    last = index + m[0].length
    if (seen.has(email)) continue
    seen.add(email)
    out.push({
      email,
      name: before === '' || before.includes('@') ? null : before,
    })
  }
  return out
}

/**
 * The first Forwarded-message block in a plain-text body, or null when there
 * is none. "First" is the most recent forward, which is the message the
 * person meant.
 */
export function parseForwarded(text: string): ForwardedBlock | null {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^(?:>\s?)+/, '').replace(/\s+$/, ''))

  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].trim()
    if (!MARKERS.some((re) => re.test(marker))) continue
    const block = readHeaders(lines, i + 1)
    if (block !== null) return block
  }
  return null
}

function readHeaders(
  lines: ReadonlyArray<string>,
  start: number,
): ForwardedBlock | null {
  let i = start
  while (i < lines.length && lines[i].trim() === '') i++

  const fields = new Map<string, string>()
  let current: string | null = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      // Apple Mail and Outlook sometimes leave one blank line inside the
      // block; a blank line followed by another header keeps reading.
      const next = lines.at(i + 1)?.trim() ?? ''
      const nextHeader = HEADER.exec(next)
      if (nextHeader && KNOWN.has(nextHeader[1].toLowerCase())) continue
      break
    }
    const header = HEADER.exec(line.trim())
    if (header && KNOWN.has(header[1].toLowerCase())) {
      current = header[1].toLowerCase()
      const prior = fields.get(current)
      fields.set(
        current,
        prior === undefined ? header[2] : `${prior} ${header[2]}`,
      )
    } else if (current !== null && /^\s/.test(line)) {
      fields.set(current, `${fields.get(current) ?? ''} ${line.trim()}`)
    } else {
      break
    }
  }

  const fromLine = fields.get('from')
  if (fromLine === undefined) return null
  const from = parseAddresses(fromLine).at(0) ?? null
  if (from === null) return null

  const dateLine = fields.get('date') ?? fields.get('sent') ?? null
  const referencesLine = fields.get('references')
  return {
    from,
    to: parseAddresses(fields.get('to') ?? ''),
    cc: parseAddresses(fields.get('cc') ?? ''),
    date: dateLine === null ? null : parseLooseDate(dateLine),
    subject: fields.get('subject')?.trim() || null,
    messageId: normalizeMessageId(fields.get('message-id')),
    inReplyTo: normalizeMessageId(
      messageIdList(fields.get('in-reply-to') ?? '').at(0),
    ),
    references:
      referencesLine === undefined ? [] : messageIdList(referencesLine),
  }
}

const MONTHS: ReadonlyArray<string> = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]

/** Minutes east of UTC for the abbreviations mail clients actually print. */
const ZONES: Readonly<Record<string, number>> = {
  ut: 0,
  utc: 0,
  gmt: 0,
  z: 0,
  bst: 60,
  ist: 330,
  cet: 60,
  cest: 120,
  eet: 120,
  eest: 180,
  wet: 0,
  west: 60,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
  jst: 540,
  sgt: 480,
  aest: 600,
  aedt: 660,
}

/**
 * The date line of a forwarded block, in whichever client's spelling:
 * `Mon, Sep 21, 2026 at 10:04 AM`, `Monday, September 21, 2026 10:04 AM`,
 * `21 September 2026 at 10:04:00 BST`, `Mon, 21 Sep 2026 10:04:00 +0100`,
 * `2026-09-21 10:04`. Hand-rolled rather than `Date.parse`, whose non-ISO
 * behaviour is implementation-defined and reads a zoneless time in the
 * *worker's* timezone. A line with no zone (Gmail's and Outlook's are
 * zoneless: they print the forwarder's local time) is read as UTC — wrong by
 * the forwarder's offset, never by a day's worth of guessing. Null when no
 * day, month and year can be found.
 */
export function parseLooseDate(line: string): Date | null {
  const s = line
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\bat\b/g, ' ')

  let year: number | null = null
  let month: number | null = null
  let day: number | null = null

  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s)
  const slashed = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(s)
  if (iso) {
    year = Number(iso[1])
    month = Number(iso[2]) - 1
    day = Number(iso[3])
  } else if (slashed) {
    const a = Number(slashed[1])
    const b = Number(slashed[2])
    year = Number(slashed[3])
    // 21/09/2026 can only be day-first; 09/21/2026 only month-first; an
    // ambiguous pair is read the US way, which is Outlook's default.
    if (a > 12) {
      day = a
      month = b - 1
    } else {
      month = a - 1
      day = b
    }
  } else {
    const monthWord =
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/.exec(s)
    const yearWord = /\b(\d{4})\b/.exec(s)
    if (monthWord === null || yearWord === null) return null
    month = MONTHS.indexOf(monthWord[1])
    year = Number(yearWord[1])
    // The day is the 1–2 digit number that is not part of the time.
    const withoutTime = s.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
    const dayWord = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(withoutTime)
    if (dayWord === null) return null
    day = Number(dayWord[1])
  }

  let hour = 0
  let minute = 0
  let second = 0
  const time = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/.exec(
    s,
  )
  if (time) {
    hour = Number(time[1])
    minute = Number(time[2])
    const groups: Array<string | undefined> = [...time]
    second = groups[3] === undefined ? 0 : Number(groups[3])
    const meridiem = groups[4]?.replace(/\./g, '')
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
  }

  let offset = 0
  const numeric = /(?:^|\s|gmt|utc)([+-])(\d{2}):?(\d{2})\b/.exec(s)
  if (numeric) {
    offset =
      (numeric[1] === '-' ? -1 : 1) *
      (Number(numeric[2]) * 60 + Number(numeric[3]))
  } else {
    const words = s.split(/[\s()]+/)
    const zone = words.find((w) => w in ZONES)
    if (zone !== undefined) offset = ZONES[zone]
  }

  if (
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  )
    return null
  const ms = Date.UTC(year, month, day, hour, minute, second) - offset * 60_000
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date
}
