import { useRouter } from '@tanstack/react-router'
import { CheckCheck, Columns3 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { acceptSuggestionColumn } from '#/lib/server-fns'
import type { ColumnRunRow, ColumnRunSummary } from '#/lib/server-fns'
import { SuggestionCard, batchSummary, usageRunHref } from './suggestion-card'

/**
 * A column run in the review inbox (SPA-122): every open suggestion one run
 * wrote, gathered under one header — what ran, where it stands, and "Accept
 * all", which accepts the run's attribute across the run's suggestions
 * through `acceptColumnProgram` (never the same attribute proposed by
 * another run). The members are the ordinary per-record cards, so each is
 * still accepted or rejected on its own; a registry proposal among them is
 * not something "Accept all" touches — it proposes no value.
 */

/** "Column run · Why now? · Screening" → "Why now? · Screening". */
const titleOf = (task: string) => task.split(' · ').slice(1).join(' · ') || task

/**
 * The header's summary line. A run the daily cap stopped carries its own
 * sentence — rows done, rows left — written when it closed.
 */
export function columnRunStatusLine(
  run: Pick<ColumnRunSummary, 'status' | 'rowsRun'>,
  open: number,
): string {
  const rows = `${String(run.rowsRun)} row${run.rowsRun === 1 ? '' : 's'} run`
  const waiting = `${String(open)} waiting`
  switch (run.status) {
    case 'running':
      return `running · ${rows} so far · ${waiting}`
    case 'done':
      return `done · ${rows} · ${waiting}`
    case 'failed':
      return `stopped · ${rows} · ${waiting}`
  }
}

export function ColumnRunGroup({ group }: { group: ColumnRunRow }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const open = group.cards.reduce((n, c) => n + c.suggestions.length, 0)
  const slug = group.attributeSlug

  async function acceptAll(attributeSlug: string) {
    setPending(true)
    try {
      const outcomes = await acceptSuggestionColumn({
        data: { attributeSlug, runId: group.run.id },
      })
      const summary = batchSummary(outcomes)
      if (outcomes.some((o) => o.ok)) toast(summary)
      else toast.error(summary)
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="flex flex-col gap-3">
      <div className="flex flex-col border border-hairline bg-paper shadow-[3px_3px_0_0_var(--hairline)]">
        <div className="flex min-h-11 flex-wrap items-center gap-3 px-5 py-2.5">
          <Columns3 className="size-3.5 text-graphite" strokeWidth={1.75} />
          <span className="label-caps text-graphite">From this column run</span>
          <h2 className="min-w-0 truncate font-serif text-lg leading-5.5 font-semibold">
            {titleOf(group.run.task)}
          </h2>
          <span className="mono text-micro text-graphite">
            {columnRunStatusLine(group.run, open)}
          </span>
          {slug === null ? null : (
            <Button
              size="xs"
              className="ml-auto"
              disabled={pending}
              title="Accept this run’s value on every record below, field by field"
              onClick={() => void acceptAll(slug)}
            >
              <CheckCheck className="size-3" strokeWidth={2} />
              Accept all
            </Button>
          )}
        </div>
        {group.run.error === null ? null : (
          <p
            role="status"
            className="border-t border-rule bg-bone px-5 py-2 text-label text-graphite"
          >
            {group.run.error}
          </p>
        )}
        <div className="border-t border-rule px-5 py-1.5">
          <a
            href={usageRunHref(group.run.id)}
            className="focus-ring mono text-micro text-graphite hover:text-foreground hover:underline"
          >
            open the run in Usage ›
          </a>
        </div>
      </div>
      <ul
        aria-label={`Suggestions from ${titleOf(group.run.task)}`}
        className="flex flex-col gap-3 border-l border-rule pl-4"
      >
        {group.cards.map((card) => (
          <SuggestionCard key={card.id} card={card} />
        ))}
      </ul>
    </li>
  )
}
