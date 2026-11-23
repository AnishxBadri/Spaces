import { useState } from 'react'
import { formatBytes } from '@spaces/core/documents'
import { variableSegments } from '@spaces/core/templates/variables'
import { FileGlyph } from '#/components/files/file-glyph'
import { Checkbox } from '#/components/ui/checkbox'
import { fileType } from '#/lib/documents/files-tab'
import { openBlanks, reviewCopies } from '#/lib/email/compose'
import type { DraftState, ReviewChoices } from '#/lib/email/compose'
import type {
  DraftDocument,
  DraftRecipient,
  EmailParticipant,
  VariableReview,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { HeaderLine } from './message-card'

/**
 * Review, the composer's second stage: the email as the message card it
 * will become, on bone. With variables each To recipient gets a copy: the
 * recipients on the left (the Bcc after them, in graphite), the picked one's
 * card on the right.
 * - A resolved variable prints as it will go; a blank is an amber-outlined
 *   chip until it is filled for that copy or left blank, in the fill rows
 *   under the card.
 * - A copy with an open blank is flagged with an amber square and its count;
 *   Send stays off until none is (`openBlanks`).
 */

type Row = VariableReview['rows'][number]

/** The variable's text in this copy, or null while it is an open blank. */
function valueIn(
  row: Row | null,
  path: string,
  choices: ReviewChoices,
): string | null {
  if (row === null) return null
  const resolved = row.values[path] ?? null
  if (resolved !== null) return resolved
  const fill = choices.fills[row.email]?.[path] ?? ''
  if (fill.trim() !== '') return fill
  return choices.accepted.includes(row.email) ? '' : null
}

/** `text` as this copy reads it, an open blank drawn as its amber chip. */
function Copy({
  text,
  row,
  choices,
}: {
  text: string
  row: Row | null
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
              className="inline-flex h-5.5 items-center rounded-md border border-warning bg-paper px-1.5 align-middle mono text-micro text-foreground"
            >
              {s.path}
            </span>
          )
        return (
          <span key={i} data-resolved={s.path}>
            {v}
          </span>
        )
      })}
    </>
  )
}

const asParticipant = (r: DraftRecipient): EmailParticipant => ({
  email: r.email,
  name: r.name ?? null,
  you: false,
})

/** A file the email carries, as the card will show it: glyph, name, size. */
function DraftFile({ file }: { file: DraftDocument }) {
  return (
    <li
      data-review-file={file.documentId}
      className="flex w-55 shrink-0 items-center gap-2 rounded-md border border-rule px-2.5 py-2"
    >
      <FileGlyph
        type={fileType({
          filename: file.name,
          mime: file.mime,
          externalUrl: null,
        })}
      />
      <span className="min-w-0 flex-1 text-label break-words">{file.name}</span>
      {file.sizeBytes === null ? null : (
        <span className="shrink-0 mono text-micro text-graphite">
          {formatBytes(file.sizeBytes)}
        </span>
      )}
    </li>
  )
}

/**
 * One message as it will go: `You → Dev Shah, bcc Kavya Iyer` with the
 * sending address at the right, the subject, the body, the files, then a
 * fill row for each of this copy's blanks.
 */
function ReviewCard({
  draft,
  to,
  row,
  choices,
  onChange,
  from,
  subject,
}: {
  draft: DraftState
  /** Who this message goes to: one recipient's copy, or the whole To. */
  to: ReadonlyArray<DraftRecipient>
  row: Row | null
  choices: ReviewChoices
  onChange: (next: ReviewChoices) => void
  /** The sending address; null while there is no mailbox to send with. */
  from: string | null
  /** Off for a reply in its thread, whose head already carries it. */
  subject: boolean
}) {
  const who = row === null ? null : (row.name ?? row.email)
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
  const blanks = row?.blanks ?? []

  return (
    <article
      data-review-card
      {...(row === null ? {} : { 'data-review-copy': row.email })}
      className="flex shrink-0 flex-col border border-hairline bg-paper"
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-rule px-4">
        <span data-sender-line className="min-w-0 flex-1 truncate text-ui">
          <HeaderLine
            head={{
              from: { email: from ?? '', name: null, you: true },
              to: to.map(asParticipant),
              cc: draft.cc.map(asParticipant),
            }}
            bcc={draft.bcc.map(asParticipant)}
            folded={false}
            tips
          />
        </span>
        {from === null ? null : (
          <span
            data-review-from
            className="shrink-0 mono text-micro text-graphite"
          >
            {from}
          </span>
        )}
      </header>
      <div className="flex flex-col gap-3 p-4">
        {subject ? (
          <p data-review-subject className="text-ui font-medium">
            <Copy text={draft.subject} row={row} choices={choices} />
          </p>
        ) : null}
        <div
          data-review-body
          className="font-serif text-title leading-6.75 break-words whitespace-pre-wrap"
        >
          <Copy text={draft.bodyMd} row={row} choices={choices} />
        </div>
      </div>
      {draft.attachments.length === 0 ? null : (
        <ul
          aria-label="Files"
          className="flex flex-wrap gap-2 border-t border-rule px-4 py-3"
        >
          {draft.attachments.map((f) => (
            <DraftFile key={f.documentId} file={f} />
          ))}
        </ul>
      )}
      {row === null || who === null || blanks.length === 0 ? null : (
        <ol className="flex flex-col">
          {blanks.map((path, i) => (
            <li
              key={path}
              data-fill-row={path}
              className="flex h-10 shrink-0 items-center gap-3 border-t border-rule px-4"
            >
              <span className="w-22 shrink-0 truncate mono text-micro text-graphite">
                {path}
              </span>
              <input
                aria-label={`${path} for ${who}`}
                placeholder="For this copy"
                value={choices.fills[row.email]?.[path] ?? ''}
                onChange={(e) => fill(row.email, path, e.target.value)}
                className="focus-ring h-7 min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 text-ui outline-none placeholder:text-graphite"
              />
              {/* Leave blank covers every blank of this copy: once, on the last row. */}
              {i === blanks.length - 1 ? (
                <label className="flex shrink-0 items-center gap-2 text-label">
                  <Checkbox
                    aria-label={`Leave the blanks for ${who} empty`}
                    checked={choices.accepted.includes(row.email)}
                    onCheckedChange={(on) => accept(row.email, on)}
                  />
                  Leave blank
                </label>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}

/**
 * Review's body. One message is one card; a copy each is the 220px list of
 * recipients beside the picked copy's card. `card` is a reply in its
 * thread: the card stands in the thread's column, which is already bone.
 */
export function ReviewPanes({
  review,
  draft,
  choices,
  onChange,
  from,
  card = false,
}: {
  review: VariableReview
  draft: DraftState
  choices: ReviewChoices
  onChange: (next: ReviewChoices) => void
  from: string | null
  card?: boolean
}) {
  const copies = reviewCopies(review.rows, draft.to, review.paths.length > 0)
  const firstFlagged =
    copies.find((r) => openBlanks(r, choices).length > 0) ?? copies.at(0)
  const [picked, setPicked] = useState<string | null>(
    firstFlagged?.email ?? null,
  )
  const row = copies.find((r) => r.email === picked) ?? copies.at(0) ?? null
  const toOf = (r: Row | null): ReadonlyArray<DraftRecipient> =>
    r === null
      ? draft.to
      : draft.to.filter((t) => t.email.toLowerCase() === r.email.toLowerCase())
  const cardFor = (r: Row | null) => (
    <ReviewCard
      draft={draft}
      to={toOf(r)}
      row={r}
      choices={choices}
      onChange={onChange}
      from={from}
      subject={!card}
    />
  )

  if (copies.length < 2)
    return card ? (
      cardFor(row)
    ) : (
      <section
        aria-label="Review"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bone p-3"
      >
        {cardFor(row)}
      </section>
    )

  return (
    <section
      aria-label="Review"
      className={cn(
        'flex min-h-80 flex-1 bg-bone',
        card && 'shrink-0 border border-rule',
      )}
    >
      <ol
        aria-label="Recipients"
        className="flex w-55 shrink-0 flex-col overflow-y-auto border-r border-rule bg-paper"
      >
        {copies.map((r) => {
          const open = openBlanks(r, choices)
          const current = r.email === row?.email
          return (
            <li key={r.email}>
              <button
                type="button"
                data-review-row={r.email}
                {...(open.length > 0 ? { 'data-flagged': true } : {})}
                aria-current={current ? 'true' : undefined}
                onClick={() => setPicked(r.email)}
                className={cn(
                  'focus-ring-inset relative flex h-10 w-full items-center gap-2 border-b border-rule px-4 text-left text-ui hover:bg-bone',
                  current &&
                    'bg-bone before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-hairline',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {r.name ?? r.email}
                </span>
                {open.length > 0 ? (
                  <>
                    <span aria-hidden className="size-2 shrink-0 bg-warning" />
                    <span className="shrink-0 mono text-micro">
                      {open.length}
                    </span>
                  </>
                ) : null}
              </button>
            </li>
          )
        })}
        {draft.bcc.map((b) => (
          <li
            key={b.email}
            data-review-bcc={b.email}
            className="flex h-10 shrink-0 items-center gap-2 border-b border-rule px-4 text-ui text-graphite"
          >
            <span className="min-w-0 flex-1 truncate">{b.name ?? b.email}</span>
            <span className="shrink-0 mono text-micro">Bcc</span>
          </li>
        ))}
      </ol>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-3">
        {cardFor(row)}
      </div>
    </section>
  )
}
