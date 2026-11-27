import { Band } from '../ledger-section'
import { FilesRow } from './files-row'
import type { FilesLedgerRow } from '#/lib/documents/files-ledger'

/**
 * The Files page's first band, `Unfiled n`, while anything is unfiled: the
 * count is every unfiled file the list matches, its rows those on screen.
 * Its own part so rows that are still arriving can stand in it beside the
 * ones that have.
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
  if (count === 0 && rows.length === 0) return null
  return (
    <section aria-label="Unfiled" data-files-band="unfiled">
      <Band
        label={
          <>
            Unfiled
            <span className="tabular ml-1.5 text-foreground">{count}</span>
          </>
        }
      />
      <ol>
        {rows.map((row) => (
          <FilesRow key={row.id} row={row} onOpen={() => onOpen(row.id)} />
        ))}
      </ol>
    </section>
  )
}
