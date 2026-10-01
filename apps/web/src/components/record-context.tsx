import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { LedgerFigure, LedgerRow, LedgerSection } from './ledger-section'
import { Switch } from '#/components/ui/switch'
import { formatSince } from '@spaces/core/format'
import type { ContextKind } from '@spaces/core/context/types'
import type { RecordContextItem } from '@spaces/core/writes/context/record'
import { getRecordContext } from '#/lib/server-fns'

/**
 * Context — what the assembler sees for this record (SPA-18,
 * spec-ai-substrate §1 / §8 step 1: the non-AI "everything about this
 * record" view). One component for all four record pages.
 *
 * Closed on first render — component state, false on every mount, so the
 * server's first paint is already the closed one. Nothing is fetched until
 * the reader opens it — the loaders do not call `getRecordContext`, so a
 * record page pays nothing for a section nobody expanded.
 *
 * `Similar judgments` (SPA-139) switches on the assembler's judgment-memory
 * mode: other deals' close_reasons and terminal-stage notes that read like
 * this record, listed in their own group after this record's own items. Off
 * on every mount and held in component state only — a sideways look you ask
 * for, never the default view, and nothing remembers it past the page.
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
  const [similar, setSimilar] = useState(false)
  const query = useQuery({
    queryKey: ['record-context', entityId, similar],
    queryFn: () =>
      getRecordContext({
        data: { entityId, budgetChars: BUDGET_CHARS, similar },
      }),
    enabled: opened,
    // Flipping the switch keeps the current list (and the switch) on screen
    // while the other assembly loads, instead of blanking to "Assembling…".
    placeholderData: keepPreviousData,
  })
  const items = query.data?.items

  // Closed at rest and drawing nothing but its head: the section is a
  // debugging view of the assembler's ranking, and a record page at 8am
  // owes it one line, not a row that explains itself (2026-09-30). `open`
  // drives the fetch as the `<details>` did — nothing loads until asked.
  const [open, setOpen] = useState(false)

  return (
    <LedgerSection
      label="Context"
      count={
        items === undefined
          ? null
          : `${String(items.length)} item${items.length === 1 ? '' : 's'}`
      }
      link={
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v)
            setOpened(true)
          }}
          className="focus-ring text-primary hover:underline"
        >
          {open ? 'hide' : 'show ›'}
        </button>
      }
    >
      {open ? (
        <li>
          {/* No pin, no switch: the lane has no vector space to look in and
              never falls back to words (lib/ai/similar.ts), so a switch
              that could only ever return nothing is not offered. */}
          {query.data?.similarAvailable === true ? (
            <div className="flex h-row items-center border-b border-rule">
              <Switch
                checked={similar}
                disabled={query.isFetching}
                onCheckedChange={setSimilar}
              >
                Similar judgments
              </Switch>
            </div>
          ) : null}
          <ol>
            <ContextBody
              status={query.status}
              items={items}
              error={query.error}
            />
          </ol>
        </li>
      ) : null}
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
      {GROUPS.map((g) => (
        <ContextGroup
          key={g.kind}
          label={g.label}
          rows={items.filter((i) => i.kind === g.kind && !i.similar)}
        />
      ))}
      <ContextGroup
        label="Similar judgments"
        rows={items.filter((i) => i.similar)}
      />
    </>
  )
}

/** One group: caps head with its count, then its rows. Absent when empty. */
function ContextGroup({
  label,
  rows,
}: {
  label: string
  rows: Array<RecordContextItem>
}) {
  if (rows.length === 0) return null
  return (
    <li>
      <div className="flex h-row items-end gap-3 border-b border-rule pb-1">
        <span className="label-caps text-label text-graphite">{label}</span>
        <span className="mono text-micro text-graphite">{rows.length}</span>
      </div>
      <ol>
        {rows.map((i) => (
          <ContextRow key={i.ref} item={i} />
        ))}
      </ol>
    </li>
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
