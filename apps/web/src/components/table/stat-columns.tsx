import { createColumnHelper } from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { DateCell } from '#/components/table/cells'
import { INTERACTION_STAT_FIELDS } from '#/lib/views/stat-fields'
import type { RowStats } from '#/lib/views/stat-fields'

/**
 * Last contact, Last email and Next meeting as table columns: read
 * from `interaction_stat`, sorted on the server by their `stat:` id, never
 * editable.
 */
export function statColumns<TRow extends { stats: RowStats }>(): Array<
  ColumnDef<TRow, unknown>
> {
  const col = createColumnHelper<TRow>()
  return INTERACTION_STAT_FIELDS.map((f) =>
    col.accessor((r): unknown => r.stats[f.rowKey], {
      id: f.slug,
      header: f.name,
      size: 120,
      meta: { numeric: true },
      cell: (info) => (
        <DateCell
          value={info.row.original.stats[f.rowKey]}
          age={f.at === 'last'}
        />
      ),
    }),
  )
}
