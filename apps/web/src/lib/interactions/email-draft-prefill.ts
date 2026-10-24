import { normalizeEmail } from '@spaces/sdk/identity'
import type { EmailDraftMode } from '@spaces/db/schema/drafts'
import type { EmailMeta } from '@spaces/db/schema/interactions'

/**
 * What a reply, a reply-all and a forward start from, computed from the
 * parent's headers. Pure: the program hands it the parent and the
 * viewer's own addresses and resolves the names after.
 * - Reply goes to the sender; replying to your own message goes to its To.
 * - Reply-all adds To and Cc, minus every address that is the viewer's.
 * - Forward starts with nobody: the quoted body and the files come with it.
 */

export type ReplyMode = Exclude<EmailDraftMode, 'new'>

export type PrefilledAddresses = { to: Array<string>; cc: Array<string> }

const keyOf = (email: string) => normalizeEmail(email) ?? email.toLowerCase()

/** The addresses, in order, without repeats or any of `drop`. */
function distinct(
  emails: ReadonlyArray<string>,
  drop: ReadonlySet<string>,
): Array<string> {
  const seen = new Set(drop)
  return emails.filter((email) => {
    const key = keyOf(email)
    if (email.trim() === '' || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function replyAddresses(
  meta: Pick<EmailMeta, 'from' | 'to' | 'cc'>,
  own: ReadonlyArray<string>,
  mode: ReplyMode,
): PrefilledAddresses {
  if (mode === 'forward') return { to: [], cc: [] }
  const mine = new Set(own.map(keyOf))
  const fromMe = mine.has(keyOf(meta.from))
  if (mode === 'reply')
    return {
      to: fromMe ? distinct(meta.to, mine) : distinct([meta.from], mine),
      cc: [],
    }
  const to = distinct([meta.from, ...meta.to], mine)
  return { to, cc: distinct(meta.cc, new Set([...mine, ...to.map(keyOf)])) }
}

/** `Re: …` / `Fwd: …`, never doubled. */
export function draftSubject(subject: string | null, mode: ReplyMode): string {
  const base = (subject ?? '').trim()
  if (mode === 'forward') return /^fwd?:/i.test(base) ? base : `Fwd: ${base}`
  return /^re:/i.test(base) ? base : `Re: ${base}`
}

/**
 * The forwarded block a forward's body starts with: the headers, then the
 * body text when the viewer may read it.
 */
export function forwardQuote(parent: {
  from: string
  to: ReadonlyArray<string>
  cc: ReadonlyArray<string>
  date: string
  subject: string | null
  body: string | null
}): string {
  const at = parent.date.slice(0, 16).replace('T', ' ')
  return [
    '---------- Forwarded message ----------',
    `From: ${parent.from}`,
    `Date: ${at} UTC`,
    `Subject: ${parent.subject ?? ''}`,
    `To: ${parent.to.join(', ')}`,
    ...(parent.cc.length > 0 ? [`Cc: ${parent.cc.join(', ')}`] : []),
    ...(parent.body === null ? [] : ['', parent.body.trim()]),
  ].join('\n')
}
