import { dayKey, formatDay, formatTime, weekdayOf } from '@spaces/core/format'
import { weekBand } from '#/lib/timeline/weeks'
import type { DraftRecipient, EmailDraftMode } from '#/lib/server-fns'

/**
 * The Email page's words and lanes: its tabs, the Threads filter, the day a
 * row ends on and the line a draft row reads. Pure and client-safe, so the
 * page, the route's search and their tests share one rule.
 */

export const EMAIL_TABS = ['threads', 'drafts'] as const
export type EmailTab = (typeof EMAIL_TABS)[number]

/**
 * Threads' filter: every thread, the ones through the reader's own
 * mailboxes, and the ones whose body someone else opened to the reader.
 */
export const THREAD_FILTERS = ['all', 'mine', 'shared'] as const
export type ThreadFilter = (typeof THREAD_FILTERS)[number]

export const THREAD_FILTER_LABEL: { [F in ThreadFilter]: string } = {
  all: 'All',
  mine: 'Mine',
  shared: 'Shared with me',
}

/** Threads a page; the foot offers this many more. */
export const THREADS_STEP = 50

/**
 * The day a row ends on: the time today, the weekday earlier this week,
 * else the day (`9 Oct`, `4 Oct 2024`).
 */
export function threadDay(at: string, now: string): string {
  const today = dayKey(now)
  if (dayKey(at) === today) return formatTime(at)
  if (weekBand(at, today) === 'This week') return weekdayOf(at)
  return formatDay(at, today)
}

const MODE_LABEL: { [M in EmailDraftMode]: string } = {
  new: 'New email',
  reply: 'Reply',
  reply_all: 'Reply all',
  forward: 'Forward',
}

/** `Dana Moreau +2`: the first recipient's name, else its address, and a count. */
export function recipientsLine(
  to: ReadonlyArray<DraftRecipient>,
): string | null {
  const first = to.at(0)
  if (first === undefined) return null
  const name = first.name ?? first.email
  return to.length === 1 ? name : `${name} +${String(to.length - 1)}`
}

/** A draft row's second line: `Reply all · Arjun Mehta +2`, or the mode alone. */
export function draftLine(row: {
  mode: EmailDraftMode
  to: ReadonlyArray<DraftRecipient>
}): string {
  const who = recipientsLine(row.to)
  return who === null
    ? MODE_LABEL[row.mode]
    : `${MODE_LABEL[row.mode]} · ${who}`
}
