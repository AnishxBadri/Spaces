import { LabelHead, LedgerRow } from '#/components/ledger-section'
import { Checkbox } from '#/components/ui/checkbox'
import { openBlanks } from '#/lib/email/compose'
import type { ReviewChoices } from '#/lib/email/compose'
import type { VariableReview } from '#/lib/server-fns'

/**
 * Review, the composer's second stage: recipients × the variables the
 * draft uses, each resolved for that recipient.
 * - A blank is flagged in its row and filled in place, or the row's blanks
 *   are accepted to go out empty.
 * - Send stays off the foot until no row is flagged (`openBlanks`).
 */
export function VariableReviewTable({
  review,
  choices,
  onChange,
}: {
  review: VariableReview
  choices: ReviewChoices
  onChange: (next: ReviewChoices) => void
}) {
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
    <section aria-label="Review" className="flex flex-col px-5 py-4">
      <LabelHead label="Recipient">
        {review.paths.map((p) => (
          <span
            key={p}
            data-variable={p}
            className="w-36 shrink-0 truncate mono text-micro text-graphite"
          >
            {`{{${p}}}`}
          </span>
        ))}
        <span className="w-24 shrink-0 text-right label-caps text-graphite">
          Leave blank
        </span>
      </LabelHead>
      {review.rows.length === 0 ? (
        <p className="px-3 py-2 text-ui text-graphite">No recipients.</p>
      ) : (
        <ol>
          {review.rows.map((row, i) => {
            const open = openBlanks(row, choices)
            const label = row.name ?? row.email
            return (
              <LedgerRow key={row.email} last={i === review.rows.length - 1}>
                <span
                  data-review-row={row.email}
                  {...(open.length > 0 ? { 'data-flagged': true } : {})}
                  className="flex min-w-0 flex-1 items-center gap-2"
                >
                  {open.length > 0 ? (
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 bg-destructive"
                    />
                  ) : null}
                  <span className="min-w-0 truncate text-ui">{label}</span>
                  {open.length > 0 ? (
                    <span className="shrink-0 mono text-micro text-destructive">
                      {open.length === 1
                        ? '1 blank'
                        : `${String(open.length)} blanks`}
                    </span>
                  ) : null}
                </span>
                {review.paths.map((p) => {
                  const value = row.values[p] ?? null
                  return value === null ? (
                    <input
                      key={p}
                      aria-label={`${p} for ${label}`}
                      placeholder="blank"
                      value={choices.fills[row.email]?.[p] ?? ''}
                      onChange={(e) => fill(row.email, p, e.target.value)}
                      className="h-6 w-36 shrink-0 border-b border-dashed border-rule bg-transparent text-ui outline-none placeholder:text-graphite focus:border-foreground"
                    />
                  ) : (
                    <span key={p} className="w-36 shrink-0 truncate text-ui">
                      {value}
                    </span>
                  )
                })}
                <span className="flex w-24 shrink-0 justify-end">
                  {row.blanks.length > 0 ? (
                    <Checkbox
                      aria-label={`Leave the blanks for ${label} empty`}
                      checked={choices.accepted.includes(row.email)}
                      onCheckedChange={(on) => accept(row.email, on)}
                    />
                  ) : null}
                </span>
              </LedgerRow>
            )
          })}
        </ol>
      )}
    </section>
  )
}
