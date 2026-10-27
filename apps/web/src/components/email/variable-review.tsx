import { useState } from 'react'
import { variableSegments } from '@spaces/core/templates/variables'
import { Checkbox } from '#/components/ui/checkbox'
import { openBlanks } from '#/lib/email/compose'
import type { ReviewChoices } from '#/lib/email/compose'
import type { VariableReview } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * Review, the composer's second stage: the recipients on the left, and on
 * the right the copy one of them receives, each variable resolved for them.
 * - A resolved variable sits on the selection wash; a blank is an amber
 *   chip until it is filled for that copy or left blank.
 * - A recipient with an open blank is flagged with a square and a count;
 *   Send stays off the foot until none is (`openBlanks`).
 */

type Row = VariableReview['rows'][number]

/** The variable's text in this copy, or null while it is an open blank. */
function valueIn(
  row: Row,
  path: string,
  choices: ReviewChoices,
): { text: string; filled: boolean } | null {
  const resolved = row.values[path] ?? null
  if (resolved !== null) return { text: resolved, filled: false }
  const fill = choices.fills[row.email]?.[path] ?? ''
  if (fill.trim() !== '') return { text: fill, filled: true }
  return choices.accepted.includes(row.email)
    ? { text: '', filled: true }
    : null
}

/** One recipient's copy of `text`, the variables drawn as chips. */
function Copy({
  text,
  row,
  choices,
}: {
  text: string
  row: Row
  choices: ReviewChoices
}) {
  return (
    <>
      {variableSegments(text).map((s, i) => {
        if (s.kind === 'text') return <span key={i}>{s.text}</span>
        const v = valueIn(row, s.path, choices)
        if (v === null)
          return (
            <span
              key={i}
              data-blank={s.path}
              className="rounded-md border border-warning bg-paper px-1 mono text-micro text-foreground"
            >
              {s.path}
            </span>
          )
        if (v.text === '') return null
        return (
          <span
            key={i}
            data-resolved={s.path}
            className="rounded-md bg-selected px-0.5"
          >
            {v.text}
          </span>
        )
      })}
    </>
  )
}

export function ReviewPanes({
  review,
  choices,
  onChange,
  subject,
  bodyMd,
}: {
  review: VariableReview
  choices: ReviewChoices
  onChange: (next: ReviewChoices) => void
  subject: string
  bodyMd: string
}) {
  const firstFlagged =
    review.rows.find((r) => openBlanks(r, choices).length > 0) ??
    review.rows.at(0)
  const [picked, setPicked] = useState<string | null>(
    firstFlagged?.email ?? null,
  )
  const row = review.rows.find((r) => r.email === picked) ?? null

  const fill = (email: string, path: string, value: string) =>
    onChange({
      ...choices,
      fills: {
        ...choices.fills,
        [email]: { ...(choices.fills[email] ?? {}), [path]: value },
      },
    })
  const accept = (email: string, on: boolean) =>
    onChange({
      ...choices,
      accepted: on
        ? [...choices.accepted, email]
        : choices.accepted.filter((e) => e !== email),
    })

  return (
    <section aria-label="Review" className="flex min-h-80 flex-1">
      <ol
        aria-label="Recipients"
        className="w-50 shrink-0 overflow-y-auto border-r border-rule bg-bone"
      >
        {review.rows.map((r) => {
          const open = openBlanks(r, choices)
          return (
            <li key={r.email}>
              <button
                type="button"
                data-review-row={r.email}
                {...(open.length > 0 ? { 'data-flagged': true } : {})}
                aria-current={r.email === picked ? 'true' : undefined}
                onClick={() => setPicked(r.email)}
                className={cn(
                  'focus-ring-inset flex h-9 w-full items-center gap-2 border-b border-rule px-3 text-left text-ui hover:bg-bone-deep',
                  r.email === picked && 'bg-paper',
                )}
              >
                {open.length > 0 ? (
                  <span aria-hidden className="size-1.5 shrink-0 bg-warning" />
                ) : null}
                <span className="min-w-0 flex-1 truncate">
                  {r.name ?? r.email}
                </span>
                {open.length > 0 ? (
                  <span className="shrink-0 mono text-micro text-graphite">
                    {open.length}
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ol>
      {row === null ? (
        <p className="flex-1 px-5 py-4 text-ui text-graphite">No recipients.</p>
      ) : (
        <div
          data-review-copy={row.email}
          className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4"
        >
          <p className="text-ui font-medium">
            <Copy text={subject} row={row} choices={choices} />
          </p>
          <div className="text-prose font-serif leading-6.75 whitespace-pre-wrap">
            <Copy text={bodyMd} row={row} choices={choices} />
          </div>
          {row.blanks.length === 0 ? null : (
            <ol className="flex flex-col border-t border-rule">
              {row.blanks.map((path) => (
                <li
                  key={path}
                  data-fill-row={path}
                  className="flex h-10 items-center gap-3 border-b border-rule"
                >
                  <span className="w-32 shrink-0 truncate mono text-micro text-graphite">
                    {path}
                  </span>
                  <input
                    aria-label={`${path} for ${row.name ?? row.email}`}
                    placeholder="For this copy only…"
                    value={choices.fills[row.email]?.[path] ?? ''}
                    onChange={(e) => fill(row.email, path, e.target.value)}
                    className="h-7 min-w-0 flex-1 border-b border-dashed border-rule bg-transparent text-ui outline-none placeholder:text-graphite focus:border-foreground"
                  />
                  <label className="flex shrink-0 items-center gap-2 text-label text-graphite">
                    <Checkbox
                      aria-label={`Leave the blanks for ${row.name ?? row.email} empty`}
                      checked={choices.accepted.includes(row.email)}
                      onCheckedChange={(on) => accept(row.email, on)}
                    />
                    Leave blank
                  </label>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}
