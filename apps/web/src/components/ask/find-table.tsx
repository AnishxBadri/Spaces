import { Link } from '@tanstack/react-router'
import { useEffect, useReducer, useState } from 'react'
import { toast } from 'sonner'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import { MoreMenu } from '#/components/ui/more-menu'
import { actOnFindRow } from '#/lib/server-fns'
import type { AskFindRow, AskFindTable } from '#/lib/server-fns'
import {
  FIND_FOLD,
  foldLine,
  foundOnLabel,
  restWord,
  rowAction,
  rowMenu,
  shownRows,
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
 * the pages it was found on and the plugin it came through, each column a
 * fixed width.
 * - A row ends on its sentence-case state word and one action — Add, or
 *   File here; Add and file here and Dismiss live in its `···`. A new
 *   record enriching carries a Twinkle.
 * - A filed row is greyed and has no control.
 * - Rows act only once the answer is stored; while it streams they read.
 * - Its head holds Save as watch, and the saved watch's line.
 */

/** How long a new record's stream may stay silent before Added stands alone. */
const QUIET_MS = 20_000

type StreamAction =
  | { kind: 'init'; rows: ReadonlyArray<JobStatusRow> }
  | { kind: 'status'; event: JobStatusEvent }

const reduce = (state: JobStatusState, action: StreamAction) =>
  action.kind === 'init'
    ? jobStatusInit(state, action.rows)
    : jobStatusEvent(state, action.event)

/** Added, Enriching, Enriched or Enrichment failed, as the new record's jobs settle. */
function useAddedWord(
  entityId: string | null,
): { word: string; working: boolean } | null {
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
      return { word: 'Enriching', working: true }
    case 'enriched':
      return { word: 'Enriched', working: false }
    case 'enrich-failed':
      return { word: 'Enrichment failed', working: false }
    case 'added':
      return { word: 'Added', working: false }
  }
}

/** Found on: the first page's host, linked, and how many more. */
function FoundOn({ row }: { row: AskFindRow }) {
  const first = row.sources.at(0)
  if (first === undefined) return null
  return (
    <a
      href={first.url}
      target="_blank"
      rel="noreferrer"
      title={row.sources.map((s) => s.url).join('\n')}
      className="focus-ring block truncate mono text-micro text-graphite hover:text-foreground"
    >
      {foundOnLabel(row)}
    </a>
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

  const rest = restWord(row)
  const state: { word: string; working: boolean } | null =
    after === null
      ? rest === null
        ? null
        : { word: rest, working: false }
      : after.act === 'dismissed'
        ? { word: 'Dismissed', working: false }
        : (addedWord ?? {
            word: after.filed ? 'Filed' : 'Added',
            working: false,
          })
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
      <td className="h-row truncate px-2">
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
      <td className="h-row truncate px-2 mono text-label text-graphite">
        {row.domain}
      </td>
      <td className="h-row truncate px-2" title={row.line}>
        {row.line}
      </td>
      <td className="h-row truncate px-2 text-graphite">{row.place ?? ''}</td>
      <td className="h-row px-2">
        <FoundOn row={row} />
      </td>
      <td className="h-row truncate px-2 mono text-micro text-graphite">
        {row.via.name}
      </td>
      <td className="h-row px-2 whitespace-nowrap">
        <span className="flex items-center justify-end gap-2">
          {state === null ? null : (
            <span
              role="status"
              className="flex items-center gap-1.5 mono text-micro text-graphite"
            >
              {state.working ? <Twinkle /> : null}
              {state.word}
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

/** The columns, each a fixed width: 1088px in all, scrolled sideways in the dock. */
const COLUMNS = [
  { head: 'Company', width: 'w-40' },
  { head: 'Domain', width: 'w-36' },
  { head: 'What it does', width: 'w-64' },
  { head: 'Place', width: 'w-28' },
  { head: 'Found on', width: 'w-36' },
  { head: 'Via', width: 'w-24' },
  { head: '', width: 'w-44' },
] as const

export function FindTable({
  table,
  turnId,
  callIndex,
  question,
  variant,
  threadId,
  line,
}: {
  table: AskFindTable
  /** The route and its time, printed over the table. */
  line: string | null
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
    <table className="w-272 table-fixed border-collapse text-ui">
      <colgroup>
        {COLUMNS.map((c) => (
          <col key={c.head} className={c.width} />
        ))}
      </colgroup>
      <thead>
        <tr className="border-b border-hairline">
          {COLUMNS.map((c) =>
            c.head === '' ? (
              <th key="state" className="h-7 px-2" aria-label="State" />
            ) : (
              <th
                key={c.head}
                className="h-7 truncate px-2 text-left field-label font-normal text-graphite"
              >
                {c.head}
              </th>
            ),
          )}
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
      line={line}
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
