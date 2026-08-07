/**
 * Deterministic natural-language due dates for the task composer
 * (CONTEXT.md 15b) — a tiny grammar, not AI: the same string must always
 * parse to the same date given the same "today". Unrecognized input
 * returns null and the caller falls back to a date input.
 *
 * `today` is passed in (ISO YYYY-MM-DD) so the function stays pure and
 * testable; callers pass the user's local date.
 */

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const day = d.getUTCDate()
  d.setUTCMonth(d.getUTCMonth() + months)
  // Clamp overflow (Jan 31 + 1mo → Feb 28/29, not Mar 2/3).
  if (d.getUTCDate() !== day) d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}

export function parseDue(input: string, today: string): string | null {
  const q = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return null

  if (q === 'today' || q === 'tod') return today
  if (q === 'tomorrow' || q === 'tmrw' || q === 'tom') return addDays(today, 1)
  if (q === 'next week') return addDays(today, 7)
  if (q === 'next month') return addMonths(today, 1)

  // "friday" / "next friday" — always the *coming* one (1–7 days out;
  // "next" is accepted but changes nothing: saying a weekday means the
  // upcoming instance, and a 13-day "next friday" surprises more than it
  // helps).
  const weekday = /^(?:next )?([a-z]+)$/.exec(q)
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1])
    if (target >= 0) {
      const current = new Date(`${today}T00:00:00Z`).getUTCDay()
      const delta = ((target - current + 6) % 7) + 1
      return addDays(today, delta)
    }
  }

  // "in 3 days" / "in 2 weeks" / "in 1 month" / "in a week"
  const rel = /^in (a|an|\d+) (day|week|month)s?$/.exec(q)
  if (rel) {
    const n = rel[1] === 'a' || rel[1] === 'an' ? 1 : Number(rel[1])
    if (n > 0 && n <= 365) {
      if (rel[2] === 'day') return addDays(today, n)
      if (rel[2] === 'week') return addDays(today, n * 7)
      return addMonths(today, n)
    }
  }

  // Bare ISO date passes through when valid.
  if (/^\d{4}-\d{2}-\d{2}$/.test(q)) {
    const d = new Date(`${q}T00:00:00Z`)
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === q)
      return q
  }

  return null
}
