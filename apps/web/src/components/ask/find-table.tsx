import { Link } from '@tanstack/react-router'
import { useEffect, useReducer, useState } from 'react'
import { toast } from 'sonner'
import { PluginMark } from '#/components/integrations/integration-ledger'
import { Button } from '#/components/ui/button'
import { MoreMenu } from '#/components/ui/more-menu'
import { actOnFindRow } from '#/lib/server-fns'
import type { AskFindRow, AskFindTable } from '#/lib/server-fns'
import {
  FIND_FOLD,
  foldLine,
  restWord,
  rowAction,
  rowMenu,
  shownRows,
  sourceLabel,
} from '#/lib/ask/find-view'
import type { FindAfter } from '#/lib/ask/find-view'
import { enrichPhase } from '#/lib/inbox/discovery-view'
import {
  decodeInit,
  decodeStatus,
  emptyJobStatus,
  jobStatusEvent,
  jobStatusInit,
} from '#/lib/integrations/job-status-view'
import type { JobStatusState } from '#/lib/integrations/job-status-view'
import type { JobStatusRow } from '#/lib/integrations/job-status'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import { cn } from '#/lib/utils'
import type { AnswerVariant } from './ask-answer'
import { FindTableHead } from './save-as-watch'

/**
 * A find's results as a table, never prose: name, domain, one line, place,
 * the pages it was found on and the plugin it came through.
 * - A row ends on its state word and one action — Add, or File here;
 *   Add and file here and Dismiss live in its `···`.
 * - A filed row is greyed and has no control.
 * - Rows act only once the answer is stored; while it streams they read.
 * - Its head holds Save as watch, and the saved watch's line.
 */

/** How long a new record's stream may stay silent before "added" stands alone. */
const QUIET_MS = 20_000

type StreamAction =
  | { kind: 'init'; rows: ReadonlyArray<JobStatusRow> }
  | { kind: 'status'; event: JobStatusEvent }

const reduce = (state: JobStatusState, action: StreamAction) =>
  action.kind === 'init'
    ? jobStatusInit(state, action.rows)
    : jobStatusEvent(state, action.event)

/** "added · enriching" until the new record's jobs settle. */
function useAddedWord(entityId: string | null): string | null {
  const [state, dispatch] = useReducer(reduce, emptyJobStatus)
  const [quiet, setQuiet] = useState(false)
  useEffect(() => {
    if (entityId === null) return
    const es = new EventSource(
      `/api/job-status/${encodeURIComponent(entityId)}`,
    )
    es.addEventListener('init', (message) => {
      const rows = decodeInit(message.data)
      if (rows !== null) dispatch({ kind: 'init', rows })
    })
    es.addEventListener('status', (message) => {
      const event = decodeStatus(message.data)
      if (event !== null) dispatch({ kind: 'status', event })
    })
    const timer = setTimeout(() => setQuiet(true), QUIET_MS)
    return () => {
      clearTimeout(timer)
      es.close()
    }
  }, [entityId])
  if (entityId === null) return null
  switch (enrichPhase(state, quiet)) {
    case 'enriching':
      return 'added · enriching'
    case 'enriched':
      return 'added · enriched'
    case 'enrich-failed':
      return 'added · enrichment failed'
    case 'added':
      return 'added'
  }
}

function Sources({ row }: { row: AskFindRow }) {
  return (
    <span className="flex gap-1">
      {row.sources.map((s) => (
        <a
          key={s.url}
          href={s.url}
          target="_blank"
          rel="noreferrer"
          title={s.url}
          className="focus-ring max-w-32 truncate rounded-md border border-rule bg-paper px-1 mono text-micro text-graphite hover:text-foreground"
        >
          {s.title ?? sourceLabel(s.url)}
        </a>
      ))}
    </span>
  )
}

function FindRow({
  row,
  table,
  turnId,
}: {
  row: AskFindRow
  table: AskFindTable
  /** Null while the answer streams: the row reads, it does not act. */
  turnId: string | null
}) {
  const [after, setAfter] = useState<FindAfter | null>(null)
  const [pending, setPending] = useState(false)
  const added = after?.act === 'added' && after.created ? after.entityId : null
  const addedWord = useAddedWord(added)

  async function act(verb: 'add' | 'file' | 'dismiss') {
    if (turnId === null) return
    setPending(true)
    try {
      const out = await actOnFindRow({
        data: { turnId, domain: row.domain, act: verb },
      })
      setAfter(
        out.acted === null
          ? { act: 'dismissed' }
          : { act: 'added', ...out.acted },
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not do that')
    } finally {
      setPending(false)
    }
  }

  const word =
    after === null
      ? restWord(row)
      : after.act === 'dismissed'
        ? 'dismissed'
        : (addedWord ?? (after.filed ? 'filed' : 'added'))
  const action =
    after === null && turnId !== null ? rowAction(row, table) : null
  const menu = after === null && turnId !== null ? rowMenu(row, table) : []
  const greyed =
    (after === null && row.standing === 'filed') || after?.act === 'dismissed'
  const record =
    row.entityId === null
      ? after?.act === 'added'
        ? after.entityId
        : null
      : row.entityId
  return (
    <tr
      data-standing={row.standing}
      data-row
      className={cn(
        'border-b border-rule last:border-b-0',
        greyed && 'text-graphite',
      )}
    >
      <td className="h-row px-2 whitespace-nowrap">
        {record === null ? (
          <span className="font-medium">{row.name}</span>
        ) : (
          <Link
            to="/companies/$companyId"
            params={{ companyId: record }}
            className="focus-ring font-medium hover:underline"
          >
            {row.name}
          </Link>
        )}
      </td>
      <td className="h-row px-2 mono text-label whitespace-nowrap text-graphite">
        {row.domain}
      </td>
      <td className="h-row max-w-72 truncate px-2" title={row.line}>
        {row.line}
      </td>
      <td className="h-row px-2 whitespace-nowrap text-graphite">
        {row.place ?? ''}
      </td>
      <td className="h-row px-2">
        <Sources row={row} />
      </td>
      <td className="h-row px-2 whitespace-nowrap">
        <span className="flex items-center gap-1.5 text-label text-graphite">
          <PluginMark name={row.via.name} />
          {row.via.name}
        </span>
      </td>
      <td className="h-row px-2 whitespace-nowrap">
        <span className="flex items-center justify-end gap-2">
          {word === null ? null : (
            <span role="status" className="mono text-micro text-graphite">
              {word}
            </span>
          )}
          {action === null ? null : (
            <Button
              size="xs"
              variant="outline"
              pending={pending}
              disabled={pending}
              onClick={() => void act(action)}
            >
              {action === 'add' ? 'Add' : 'File here'}
            </Button>
          )}
          <MoreMenu
            variant="row"
            label={row.name}
            items={[
              ...(menu.includes('add-and-file')
                ? [
                    {
                      label: 'Add and file here',
                      disabled: pending,
                      onSelect: () => void act('file'),
                    },
                  ]
                : []),
              ...(menu.includes('dismiss')
                ? [
                    {
                      label: 'Dismiss',
                      title: `Never shown again for ${table.space?.name ?? 'this space'}`,
                      disabled: pending,
                      onSelect: () => void act('dismiss'),
                    },
                  ]
                : []),
            ]}
          />
        </span>
      </td>
    </tr>
  )
}

export function FindTable({
  table,
  turnId,
  callIndex,
  question,
  variant,
  threadId,
}: {
  table: AskFindTable
  turnId: string | null
  /** The call of the turn that left this table. */
  callIndex: number
  /** The question it answered, which Save as watch is made from. */
  question: string | null
  variant: AnswerVariant
  threadId: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const foot = foldLine(table, expanded)
  const folded = !expanded && table.rows.length > FIND_FOLD
  const grid = (
    <table className="w-max min-w-full border-collapse text-ui">
      <thead>
        <tr className="border-b border-hairline">
          {[
            'Company',
            'Domain',
            'What it does',
            'Place',
            'Found on',
            'Via',
          ].map((h) => (
            <th
              key={h}
              className="h-7 px-2 text-left field-label font-normal whitespace-nowrap text-graphite"
            >
              {h}
            </th>
          ))}
          <th className="h-7 px-2" aria-label="State" />
        </tr>
      </thead>
      <tbody>
        {shownRows(table, expanded).map((row) => (
          <FindRow key={row.domain} row={row} table={table} turnId={turnId} />
        ))}
      </tbody>
    </table>
  )
  const footRow =
    foot === null ? null : (
      <div className="flex h-7 items-center gap-3 border-t border-rule px-2">
        {folded ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="focus-ring mono text-micro text-graphite hover:text-foreground"
          >
            {foot}
          </button>
        ) : (
          <span className="mono text-micro text-graphite">{foot}</span>
        )}
      </div>
    )
  const head = (
    <FindTableHead
      table={table}
      turnId={turnId}
      callIndex={callIndex}
      question={question}
    />
  )
  if (variant === 'page')
    return (
      <section
        aria-label="Companies found"
        data-breakout
        className="relative left-1/2 flex w-[calc(100cqw-4rem)] -translate-x-1/2 flex-col border-y border-rule"
      >
        {head}
        <div className="overflow-x-auto">{grid}</div>
        {footRow}
      </section>
    )
  return (
    <section
      aria-label="Companies found"
      className="flex flex-col border border-rule"
    >
      {head}
      <div className="overflow-x-auto">{grid}</div>
      {footRow}
      <div className="flex h-7 items-center justify-end border-t border-rule px-2">
        <Link
          to="/ask"
          search={threadId === null ? {} : { thread: threadId }}
          className="focus-ring mono text-micro text-graphite hover:text-foreground"
        >
          Open in /ask ›
        </Link>
      </div>
    </section>
  )
}
