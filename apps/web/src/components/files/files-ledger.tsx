import { useMemo } from 'react'
import { useClock } from '../clock'
import { Band } from '../ledger-section'
import { ListFoot } from '../table/list-foot'
import { FolderBody } from '../ui/tabs'
import { useDeletingFiles } from './delete-file'
import { FilesRow } from './files-row'
import { UnfiledBand } from './unfiled-band'
import type { FilesLedger as Ledger } from '#/lib/documents/files-ledger'
import { filesBands } from '#/lib/documents/files-ledger-view'

/**
 * The Files page's folder body: `Unfiled` first, then the date bands, the
 * rows scrolling inside the folder while the foot (`50 of 214 · Load 50
 * more`) holds its bottom. A file whose delete is in flight is left out at
 * once.
 */
export function FilesLedger({
  ledger,
  labelledBy,
  step,
  loading,
  onLoadMore,
  onOpen,
  empty,
}: {
  ledger: Ledger
  /** The ids that name the list: the page's title and the open tab. */
  labelledBy: string
  /** Rows a `Load n more` adds. */
  step: number
  /** More rows are being read. */
  loading: boolean
  onLoadMore: () => void
  /** Opens a file's window over the page. */
  onOpen: (id: string) => void
  /** What the folder says when the tab or the search holds nothing. */
  empty: string
}) {
  const { today } = useClock()
  const deleting = useDeletingFiles()
  const rows = useMemo(
    () => ledger.rows.filter((r) => !deleting.has(r.id)),
    [ledger.rows, deleting],
  )
  const bands = useMemo(() => filesBands(rows, today), [rows, today])
  const gone = ledger.rows.length - rows.length

  return (
    <FolderBody className="min-h-0 flex-1">
      <div
        role="region"
        aria-labelledby={labelledBy}
        data-files-ledger
        className="md:min-h-0 md:flex-1 md:overflow-y-auto"
      >
        {rows.length === 0 ? (
          <p
            data-list-state="none"
            className="flex h-ledger-row items-center border-b border-rule px-(--inset) text-ui text-graphite"
          >
            {empty}
          </p>
        ) : null}
        <UnfiledBand
          count={ledger.unfiled}
          rows={bands.find((b) => b.key === 'unfiled')?.rows ?? []}
          onOpen={onOpen}
        />
        {bands
          .filter((b) => b.key !== 'unfiled')
          .map((band) => (
            <section
              key={band.key}
              aria-label={band.label}
              data-files-band={band.key}
            >
              <Band label={band.label} />
              <ol>
                {band.rows.map((row) => (
                  <FilesRow
                    key={row.id}
                    row={row}
                    onOpen={() => onOpen(row.id)}
                  />
                ))}
              </ol>
            </section>
          ))}
      </div>
      <ListFoot
        folder
        {...(rows.length === 0
          ? {}
          : { count: { shown: rows.length, total: ledger.total - gone } })}
        page={{
          hasMore: ledger.rows.length < ledger.total,
          loading,
          step,
          onLoadMore,
        }}
      />
    </FolderBody>
  )
}
