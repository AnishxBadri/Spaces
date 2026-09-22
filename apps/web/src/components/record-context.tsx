import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { LedgerFigure, LedgerRow, LedgerSection } from './ledger-section'
import { formatSince } from '@spaces/core/format'
import type { ContextKind } from '#/lib/context/types'
import type { RecordContextItem } from '#/lib/context/record'
import { getRecordContext } from '#/lib/server-fns'

/**
 * Context — what the assembler sees for this record (SPA-18,
 * spec-ai-substrate §1 / §8 step 1: the non-AI "everything about this
 * record" view). One component for all four record pages.
 *
 * Closed on first render the way SPA-67's inherited lane is: a native
 * `<details>` with no `open`, so the server's first paint is already the
 * closed one. Nothing is fetched until the reader opens it — the loaders do
 * not call `getRecordContext`, so a record page pays nothing for a section
 * nobody expanded.
 */

const BUDGET_CHARS = 8000

/** Group order and caps heads. Standing sources first, as the ranker does. */
const GROUPS: ReadonlyArray<{ kind: ContextKind; label: string }> = [
  { kind: 'mandate', label: 'Mandate' },
  { kind: 'glossary', label: 'Glossary' },
  { kind: 'attribute', label: 'Attributes' },
  { kind: 'memo', label: 'Memos' },
  { kind: 'note', label: 'Notes' },
  { kind: 'doc_chunk', label: 'Documents' },
  { kind: 'event', label: 'History' },
  { kind: 'interaction', label: 'Interactions' },
  { kind: 'task', label: 'Tasks' },
]

export function RecordContext({ entityId }: { entityId: string }) {
  const [opened, setOpened] = useState(false)
  const query = useQuery({
    queryKey: ['record-context', entityId],
    queryFn: () =>
      getRecordContext({ data: { entityId, budgetChars: BUDGET_CHARS } }),
    enabled: opened,
  })
  const items = query.data?.items

  return (
    <LedgerSection
      label="Context"
      count={
        items === undefined
          ? null
          : `${String(items.length)} item${items.length === 1 ? '' : 's'}`
      }
    >
      <li>
        <details
          className="group/context"
          onToggle={(e) => {
            if (e.currentTarget.open) setOpened(true)
          }}
        >
          <summary className="focus-ring flex h-row cursor-pointer list-none items-center gap-2 border-b border-rule mono text-micro text-graphite transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3 shrink-0 transition-transform group-open/context:rotate-90"
              strokeWidth={2}
            />
            what the assembler sees, ranked
          </summary>
          <ol>
            <ContextBody
              status={query.status}
              items={items}
              error={query.error}
            />
          </ol>
        </details>
      </li>
    </LedgerSection>
  )
}

function ContextBody({
  status,
  items,
  error,
}: {
  status: 'pending' | 'error' | 'success'
  items: Array<RecordContextItem> | undefined
  error: Error | null
}) {
  if (status === 'pending')
    return (
      <LedgerRow last>
        <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
          Assembling…
        </span>
      </LedgerRow>
    )
  if (status === 'error' || items === undefined)
    return (
      <LedgerRow last>
        <span className="min-w-0 flex-1 truncate text-ui text-destructive">
          {/* The assembler's tagged errors can carry an empty message. */}
          {error?.message ? error.message : 'Could not assemble the context.'}
        </span>
      </LedgerRow>
    )
  // Empty is a row that says what belongs here, never an empty box.
  if (items.length === 0)
    return (
      <LedgerRow last>
        <span className="min-w-0 flex-1 truncate text-ui text-graphite">
          Nothing yet — notes, files and events on this record will show here.
        </span>
      </LedgerRow>
    )
  return (
    <>
      {GROUPS.map((g) => {
        const rows = items.filter((i) => i.kind === g.kind)
        if (rows.length === 0) return null
        return (
          <li key={g.kind}>
            <div className="flex h-row items-end gap-3 border-b border-rule pb-1">
              <span className="label-caps text-label text-graphite">
                {g.label}
              </span>
              <span className="mono text-micro text-graphite">
                {rows.length}
              </span>
            </div>
            <ol>
              {rows.map((i) => (
                <ContextRow key={i.ref} item={i} />
              ))}
            </ol>
          </li>
        )
      })}
    </>
  )
}

/**
 * The item's one line (the first line of its text; notes carry a body under
 * a title), then the citation in the mono lane, then how long ago it was true.
 */
function ContextRow({ item }: { item: RecordContextItem }) {
  const line = item.text.split('\n')[0] ?? item.text
  return (
    <LedgerRow>
      <span className="min-w-0 flex-1 truncate text-ui" title={item.text}>
        {line}
      </span>
      <span
        className="max-w-56 shrink truncate mono text-micro text-graphite"
        title={item.ref}
      >
        {item.cite}
      </span>
      <LedgerFigure tone="muted">
        {item.sinceMs === null ? '—' : `${formatSince(item.sinceMs)} ago`}
      </LedgerFigure>
    </LedgerRow>
  )
}
