import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { MENU_RULE, MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import type { Condition } from '@spaces/core/views/filter'
import { archiveRecord, restoreRecord } from '#/lib/server-fns'
import { AddToSpaceDialog } from './add-to-space-dialog'
import type { AddTarget } from './add-to-space-dialog'
import { BulkEnrichDialog } from './bulk-enrich-dialog'
import type { BulkTarget, EnrichKind } from './bulk-enrich-dialog'
import type { ListVerb } from './list-menu'
import type { TableSelect } from './record-table'
import { SelectionBar, useRowSelection } from './selection-bar'

/** Seconds after Enrich n at which the list re-reads, while the runs land. */
const FILL_AT = [10, 25, 45, 70]

/**
 * What a record list does to its rows, past editing a cell: the checkboxes
 * and the selection bar (`n selected · [Add to space] [Enrich…] · Clear`),
 * each row's `···` (Open in a new tab · Add to space… · Enrich… · Copy
 * link · Archive), the head's Enrich… over the view, and the two windows
 * they open.
 * - Enrich… is there only for a kind enrichment reads (`enrich` set).
 * - Add to space and Archive work on any record kind; Archive asks nothing,
 *   the row leaves, and the toast's Undo restores it.
 */
export function useListActions<T extends { id: string; name: string }>({
  label,
  noun,
  rows,
  hrefOf,
  enrich,
  refresh,
}: {
  /** The list's name — "Companies". */
  label: string
  noun: { one: string; many: string }
  /** The loaded rows. */
  rows: ReadonlyArray<T>
  /** A row's record page, from the app's root. */
  hrefOf: (row: T) => string
  /** The kind and the view as the list shows it, where Enrich… runs. */
  enrich: {
    kind: EnrichKind
    view: { conditions: Array<Condition>; q: string }
  } | null
  refresh: () => void
}): {
  select: TableSelect<T>
  selectionBar: ReactNode
  /** The head `···`'s Enrich… over the view; null where there is none. */
  enrichVerb: ListVerb | null
  rowMenu: (row: T) => ReactNode
  dialogs: ReactNode
} {
  const selection = useRowSelection()
  const [enriching, setEnriching] = useState<BulkTarget | null>(null)
  const [adding, setAdding] = useState<AddTarget | null>(null)
  const chosen = selection.among(rows.map((r) => r.id))
  const timers = useRef<Array<number>>([])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending) window.clearTimeout(t)
    }
  }, [])

  function done() {
    selection.clear()
    refresh()
  }

  function enriched() {
    done()
    for (const s of FILL_AT)
      timers.current.push(window.setTimeout(refresh, s * 1000))
  }

  async function archive(row: T) {
    try {
      await archiveRecord({ data: { id: row.id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not archive')
      return
    }
    done()
    toast(`Archived ${row.name}`, {
      action: {
        label: 'Undo',
        onClick: () =>
          void restoreRecord({ data: { id: row.id } })
            .then(refresh)
            .catch(() => toast.error('Could not undo')),
      },
    })
  }

  const rowMenu = (row: T): ReactNode => {
    const href = hrefOf(row)
    const items: Array<MoreMenuEntry> = [
      { label: 'Open in a new tab', href },
      {
        label: 'Add to space…',
        opens: true,
        onSelect: () => setAdding({ ids: [row.id], name: row.name }),
      },
      ...(enrich === null
        ? []
        : [
            {
              label: 'Enrich…',
              opens: true,
              onSelect: () => setEnriching({ ids: [row.id] }),
            },
          ]),
      { label: 'Copy link', copy: () => new URL(href, location.origin).href },
      MENU_RULE,
      { label: 'Archive', onSelect: () => void archive(row) },
    ]
    return <MoreMenu variant="row" label={row.name} items={items} />
  }

  return {
    select: { rows: selection, keyOf: (r) => r.id, nameOf: (r) => r.name },
    selectionBar:
      chosen.length > 0 ? (
        <SelectionBar
          label={`Selected ${label.toLowerCase()}`}
          count={chosen.length}
        >
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdding({ ids: chosen })}
          >
            Add to space
          </Button>
          {enrich === null ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEnriching({ ids: chosen })}
            >
              Enrich…
            </Button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={selection.clear}
            className="focus-ring rounded-md text-label text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground"
          >
            Clear
          </button>
        </SelectionBar>
      ) : null,
    enrichVerb:
      enrich === null
        ? null
        : { label: 'Enrich…', onSelect: () => setEnriching(enrich.view) },
    rowMenu,
    dialogs: (
      <>
        {enriching === null || enrich === null ? null : (
          <BulkEnrichDialog
            open
            onOpenChange={(open) => {
              if (!open) setEnriching(null)
            }}
            kind={enrich.kind}
            target={enriching}
            onSent={enriched}
          />
        )}
        {adding === null ? null : (
          <AddToSpaceDialog
            open
            onOpenChange={(open) => {
              if (!open) setAdding(null)
            }}
            target={adding}
            noun={noun}
            onAdded={done}
          />
        )}
      </>
    ),
  }
}
