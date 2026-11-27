import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useClock } from '../clock'
import { KindIcon } from '../kind-icon'
import { Band } from '../ledger-section'
import { FoldBand } from '../list/fold-band'
import { ListFoot } from '../table/list-foot'
import { FolderBody } from '../ui/tabs'
import { useDeletingFiles } from './delete-file'
import { FilesRow } from './files-row'
import { UnfiledBand } from './unfiled-band'
import { useArrivals } from '#/lib/documents/arrivals'
import type {
  FilesLedger as Ledger,
  FilesLedgerRow,
} from '#/lib/documents/files-ledger'
import type { FilesGroup, FilesSort } from '#/lib/documents/files-filter'
import { filesBands, filesGroupBands } from '#/lib/documents/files-ledger-view'
import type { FilesGroupBand } from '#/lib/documents/files-ledger-view'

/**
 * The Files page's folder body: the filter chips when any are on, then
 * `Unfiled` first in every grouping, then the bands the grouping draws
 * (dates, records, sources, adders, or none), the rows scrolling inside the
 * folder while the foot (`50 of 214 · Load 50 more`) holds its bottom. A
 * file whose delete is in flight is left out at once.
 * - Grouped by record, each record or space is a band that folds, with its
 *   count; a file under two stands in both, and its lane names only what
 *   the band does not. Which bands are folded lasts while the list stays
 *   grouped by record; it is not kept in the address.
 */
export function FilesLedger({
  ledger,
  group,
  sort,
  head,
  labelledBy,
  step,
  loading,
  onLoadMore,
  onOpen,
  empty,
}: {
  ledger: Ledger
  group: FilesGroup
  sort: FilesSort
  /** Over the rows, under the tab bar: the filters that are on. */
  head?: ReactNode
  /** The ids that name the list: the page's title and the open tab. */
  labelledBy: string
  /** Rows a `Load n more` adds. */
  step: number
  /** More rows are being read. */
  loading: boolean
  onLoadMore: () => void
  /** Opens a file's window over the page, at a page when given. */
  onOpen: (id: string, page: number | null) => void
  /** What the folder says when the tab or the search holds nothing. */
  empty: string
}) {
  const { today } = useClock()
  const deleting = useDeletingFiles()
  // Files still arriving stand in `Unfiled`, so the folder is not empty.
  const arriving = useArrivals().length > 0
  const rows = useMemo(
    () => ledger.rows.filter((r) => !deleting.has(r.id)),
    [ledger.rows, deleting],
  )
  const grouped = useMemo(
    () => (group === 'date' ? null : filesGroupBands(rows, group)),
    [rows, group],
  )
  const bands = useMemo(() => {
    if (grouped !== null) return grouped
    const dated = filesBands(rows, today)
    // Oldest first turns the date bands over; `Unfiled` still leads.
    return sort === 'oldest'
      ? [
          ...dated.filter((b) => b.key === 'unfiled'),
          ...dated.filter((b) => b.key !== 'unfiled').reverse(),
        ]
      : dated
  }, [rows, today, grouped, sort])
  const gone = ledger.rows.length - rows.length
  // A row opens at the page its search hit names.
  const open = (row: FilesLedgerRow) => onOpen(row.id, row.hit?.page ?? null)
  const byId = new Map(rows.map((r) => [r.id, r]))

  return (
    <FolderBody className="min-h-0 flex-1">
      {head}
      <div
        role="region"
        aria-labelledby={labelledBy}
        data-files-ledger
        className="md:min-h-0 md:flex-1 md:overflow-y-auto"
      >
        {rows.length === 0 && !arriving ? (
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
          onOpen={(id) => {
            const row = byId.get(id)
            onOpen(id, row?.hit?.page ?? null)
          }}
        />
        {group === 'record' && grouped !== null ? (
          <RecordBands
            bands={grouped.filter((b) => b.key !== 'unfiled')}
            counts={ledger.groups}
            onOpen={open}
          />
        ) : (
          bands
            .filter((b) => b.key !== 'unfiled')
            .map((band) => (
              <section
                key={band.key}
                aria-label={band.label === '' ? 'Filed' : band.label}
                data-files-band={band.key}
              >
                {band.label === '' ? null : (
                  <Band
                    label={
                      group === 'date' ? (
                        band.label
                      ) : (
                        <>
                          {band.label}
                          <span className="tabular ml-1.5 text-foreground">
                            {ledger.groups[band.key] ?? band.rows.length}
                          </span>
                        </>
                      )
                    }
                  />
                )}
                <ol>
                  {band.rows.map((row) => (
                    <FilesRow key={row.id} row={row} onOpen={() => open(row)} />
                  ))}
                </ol>
              </section>
            ))
        )}
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

/** One folding band per record or space, its count every file under it. */
function RecordBands({
  bands,
  counts,
  onOpen,
}: {
  bands: ReadonlyArray<FilesGroupBand<FilesLedgerRow>>
  counts: Readonly<Record<string, number>>
  onOpen: (row: FilesLedgerRow) => void
}) {
  const base = useId()
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  return bands.map((band) => {
    const open = !folded.has(band.key)
    const rowsId = `${base}-${band.key}`
    return (
      <section
        key={band.key}
        aria-label={band.label}
        data-files-band={band.key}
        data-folded={!open}
      >
        <FoldBand
          label={band.label}
          count={counts[band.key] ?? band.rows.length}
          mark={
            band.kind === null ? null : (
              <KindIcon
                of={{ kind: band.kind, objectLabel: null, objectIcon: null }}
                className="text-graphite"
              />
            )
          }
          open={open}
          onOpenChange={(next) =>
            setFolded((prev) => {
              const out = new Set(prev)
              if (next) out.delete(band.key)
              else out.add(band.key)
              return out
            })
          }
          controls={rowsId}
        />
        <ol id={rowsId} hidden={!open}>
          {band.rows.map((row) => (
            <FilesRow
              key={row.id}
              row={row}
              band={band.key}
              onOpen={() => onOpen(row)}
            />
          ))}
        </ol>
      </section>
    )
  })
}
