import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { answerBlocks, citedRefs } from '#/lib/ask/answer'
import type { AnswerBlock, AnswerSegment } from '#/lib/ask/answer'
import type { AskRef } from '#/lib/ask/types'
import { cn } from '#/lib/utils'

/**
 * An answer, set in sans: text with every claim's sources as ref chips, and
 * any claim that carries none withheld behind one line.
 * - `dock`: a table scrolls sideways inside its card, with "Open in /ask ›".
 * - `page`: a table breaks out of the 760px column to the content width,
 *   which the page declares as an inline-size container.
 */

export type AnswerVariant = 'dock' | 'page'

/** One source chip: the label it was cited as, linked when it has a page. */
export function RefChip({ source }: { source: AskRef }) {
  const cls =
    'mx-0.5 inline-flex h-4.5 max-w-48 items-center truncate rounded-md border border-rule bg-bone px-1 align-baseline mono text-micro text-graphite'
  return source.href === null ? (
    <span className={cls} title={source.ref}>
      {source.label}
    </span>
  ) : (
    <Link
      to={source.href}
      className={cn(cls, 'focus-ring hover:text-foreground')}
      title={source.ref}
    >
      {source.label}
    </Link>
  )
}

function Segments({ segments }: { segments: ReadonlyArray<AnswerSegment> }) {
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'ref' ? (
          <RefChip key={`${s.ref.ref}-${i}`} source={s.ref} />
        ) : s.strong ? (
          <strong key={i} className="font-medium">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  )
}

export function RefusedClaim() {
  return (
    <p className="mono text-micro text-graphite">
      A claim with no source was left out.
    </p>
  )
}

function Table({
  block,
  variant,
  openInAsk,
}: {
  block: Extract<AnswerBlock, { kind: 'table' }>
  variant: AnswerVariant
  openInAsk: ReactNode
}) {
  const table = (
    <table className="w-max min-w-full border-collapse text-ui">
      <thead>
        <tr className="border-b border-hairline">
          {block.head.map((cell, i) => (
            <th
              key={i}
              className="h-7 px-2 text-left field-label font-normal whitespace-nowrap text-graphite"
            >
              <Segments segments={cell} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((row, r) => (
          <tr key={r} className="border-b border-rule last:border-b-0">
            {row.map((cell, c) => (
              <td key={c} className="h-row px-2 whitespace-nowrap">
                <Segments segments={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
  if (variant === 'page')
    return (
      // The page is an inline-size container; the table spans it, centred
      // on the 760px column it breaks out of.
      <div
        data-breakout
        className="relative left-1/2 w-[calc(100cqw-4rem)] -translate-x-1/2 overflow-x-auto border-y border-rule"
      >
        {table}
      </div>
    )
  return (
    <div className="flex flex-col border border-rule">
      <div className="overflow-x-auto">{table}</div>
      <div className="flex h-7 items-center justify-end border-t border-rule px-2">
        {openInAsk}
      </div>
    </div>
  )
}

export function AskAnswer({
  body,
  refs,
  variant,
  threadId,
  streaming = false,
}: {
  body: string
  refs: ReadonlyArray<AskRef>
  variant: AnswerVariant
  threadId: string | null
  /** Arriving now: chips name the kind cited, and nothing is withheld yet. */
  streaming?: boolean
}) {
  const shown = streaming
    ? citedRefs(body).map((r): AskRef => ({
        ref: r,
        label: r.slice(0, r.indexOf(':')),
        href: null,
        entityId: null,
      }))
    : refs
  const blocks = answerBlocks(body, shown, !streaming)
  const openInAsk = (
    <Link
      to="/ask"
      search={threadId === null ? {} : { thread: threadId }}
      className="focus-ring mono text-micro text-graphite hover:text-foreground"
    >
      Open in /ask ›
    </Link>
  )
  return (
    <div className="flex flex-col gap-2.5 font-sans text-body text-foreground">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return (
              <h3 key={i} className="pt-1 text-title font-medium">
                <Segments segments={b.segments} />
              </h3>
            )
          case 'paragraph':
            return (
              <p key={i}>
                <Segments segments={b.segments} />
              </p>
            )
          case 'item':
            return (
              <p
                key={i}
                className="relative pl-4 before:absolute before:left-1 before:text-graphite before:content-['–']"
                style={{ marginLeft: `${b.depth}rem` }}
              >
                <Segments segments={b.segments} />
              </p>
            )
          case 'table':
            return (
              <Table
                key={i}
                block={b}
                variant={variant}
                openInAsk={openInAsk}
              />
            )
          case 'refused':
            return <RefusedClaim key={i} />
        }
      })}
    </div>
  )
}
