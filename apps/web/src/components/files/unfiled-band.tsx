import { Band } from '../ledger-section'
import { ArrivalRow } from './arrival-row'
import { FilesRow } from './files-row'
import { useArrivals } from '#/lib/documents/arrivals'
import type { FilesLedgerRow } from '#/lib/documents/files-ledger'

/**
 * The Files page's first band, `Unfiled n`, while anything is unfiled or
 * arriving: the count is every unfiled file the list matches plus the files
 * still uploading, its rows the arriving files first, then those on screen.
 * - Arriving rows stand here under every tab, filter, search and grouping:
 *   they are what the reader just did. Once read, a file shows only if the
 *   list matches it.
 */
export function UnfiledBand({
  count,
  rows,
  onOpen,
}: {
  count: number
  rows: ReadonlyArray<FilesLedgerRow>
  /** Opens a file's window over the page. */
  onOpen: (id: string) => void
}) {
  const shown = new Set(rows.map((r) => r.id))
  // A landed file the list already shows is that row now, not two.
  const arriving = useArrivals().filter(
    (a) => a.state.kind !== 'landed' || !shown.has(a.state.documentId),
  )
  const coming = arriving.filter(
    (a) => a.state.kind === 'uploading' || a.state.kind === 'landed',
  ).length
  if (count === 0 && rows.length === 0 && arriving.length === 0) return null
  return (
    <section aria-label="Unfiled" data-files-band="unfiled">
      <Band
        label={
          <>
            Unfiled
            <span className="tabular ml-1.5 text-foreground">
              {count + coming}
            </span>
          </>
        }
      />
      <ol>
        {arriving.map((a) => (
          <ArrivalRow key={a.key} arrival={a} onOpen={onOpen} />
        ))}
        {rows.map((row) => (
          <FilesRow key={row.id} row={row} onOpen={() => onOpen(row.id)} />
        ))}
      </ol>
    </section>
  )
}
