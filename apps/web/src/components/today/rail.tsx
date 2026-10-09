import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { MovingSignal } from '#/lib/server-fns'
import { daysBetween } from '#/lib/today/needs-you'

/** The rail's time lane, date-only so server and client agree. */
function whenLabel(atIso: string, today: string): string {
  const d = daysBetween(atIso, today)
  if (d === 0) return 'today'
  if (d === 1) return 'yest'
  return atIso.slice(5, 10)
}

/** A citation's printed form: the host, without `www.`. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function RailHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-baseline justify-between pb-2.5">
      <h2 className="text-title font-medium text-foreground">{title}</h2>
      <span className="mono text-micro text-graphite">{meta}</span>
    </div>
  )
}

/**
 * What's moving: signals from the last seven days on the reader's companies,
 * newest first, each citing where it was read. Renders nothing when quiet.
 */
export function WhatsMoving({
  signals,
  today,
}: {
  signals: ReadonlyArray<MovingSignal>
  today: string
}) {
  if (signals.length === 0) return null
  return (
    <section className="flex flex-col border-b border-hairline px-6 py-5">
      <RailHead title="What's moving" meta={`${signals.length} · 7d`} />
      <ol>
        {signals.map((s) => {
          const host = s.url === null ? null : hostOf(s.url)
          return (
            <li
              key={s.id}
              className="flex items-start gap-3 border-t border-rule py-2"
            >
              <span className="w-11 shrink-0 mono text-micro text-graphite">
                {whenLabel(s.observedAt, today)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <Link
                  to="/companies/$companyId"
                  params={{ companyId: s.companyId }}
                  className="focus-ring truncate text-label font-medium text-foreground hover:underline"
                >
                  {s.companyName}
                </Link>
                <span className="text-label text-foreground">
                  {s.title ?? s.kind ?? 'Signal'}
                </span>
              </span>
              {s.url !== null && host !== null ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring max-w-28 shrink-0 truncate mono text-micro text-graphite hover:text-foreground"
                >
                  {host}
                </a>
              ) : (
                <span className="shrink-0 mono text-micro text-graphite">
                  {s.source}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export type TeamEntry = {
  id: string
  verb: string
  at: string
  actorName: string
  subjectName: string | null
}

/** Two-letter type code for a ledger entry, from the verb's subject. */
function verbCode(verb: string): string {
  const [subject, action] = verb.split('.')
  const CODES: Record<string, string> = {
    mark: 'MK',
    investment: 'IN',
    round: 'RD',
    holding: 'HL',
    deal: 'DL',
    company: 'CO',
    person: 'PE',
    note: 'NT',
    document: 'FI',
    space: 'SP',
    term: 'TM',
    mandate: 'MD',
    task: 'TK',
    interaction: 'IX',
    signal: 'SG',
  }
  return CODES[subject] ?? (action ? subject : verb).slice(0, 2).toUpperCase()
}

/**
 * The team's last 24 hours, folded behind "team activity ›" and opened in
 * place. Renders nothing when nobody did anything.
 */
export function TeamActivity({
  entries,
  today,
}: {
  entries: ReadonlyArray<TeamEntry>
  today: string
}) {
  const [open, setOpen] = useState(false)
  if (entries.length === 0) return null
  return (
    <section className="flex flex-col px-6 py-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring flex items-baseline justify-between text-left mono text-micro text-graphite hover:text-foreground"
      >
        <span>team activity {open ? '‹' : '›'}</span>
        <span>{entries.length} · 24h</span>
      </button>
      {open ? (
        <ol className="pt-2.5">
          {entries.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-3 border-t border-rule py-2"
            >
              <span className="w-11 shrink-0 mono text-micro text-graphite">
                {whenLabel(a.at, today)}
              </span>
              <span className="w-5 shrink-0 mono text-field font-medium">
                {verbCode(a.verb)}
              </span>
              <span className="min-w-0 text-label leading-4.25">
                <span className="font-medium">{a.actorName}</span>{' '}
                {a.verb.replace(/[._]/g, ' ')}
                {a.subjectName ? ` · ${a.subjectName}` : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
