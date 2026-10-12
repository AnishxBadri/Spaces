import { createColumnHelper } from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { ValueEditor } from '#/components/attributes/value-editor'
import type {
  RefNames,
  RegistryEntry,
} from '#/components/attributes/value-editor'
import { attributeColumnMeta } from '#/components/table/cells'
import { inverseCountSlug } from '#/lib/views/inverse-fields'

/**
 * An inverse attribute's two columns (D69): the referencing records, edited
 * as the owner's value, and their count, read-only. Both sort and filter on
 * the server; the list page fills the row's values with them.
 */
export function inverseColumns<
  TRow extends { id: string; values: Readonly<Record<string, unknown>> },
>(
  inverses: ReadonlyArray<RegistryEntry>,
  opts: {
    refNames: RefNames
    onSave: (entityId: string, slug: string, value: unknown) => Promise<void>
  },
): Array<ColumnDef<TRow, unknown>> {
  const col = createColumnHelper<TRow>()
  return inverses.flatMap((def) => [
    col.accessor((r): unknown => r.values[def.slug] ?? null, {
      id: `attr:${def.slug}`,
      header: def.name,
      size: 180,
      meta: attributeColumnMeta(def.type),
      cell: (info) => (
        <ValueEditor
          def={def}
          value={info.getValue()}
          variant="cell"
          refNames={opts.refNames}
          onSave={(v) => void opts.onSave(info.row.original.id, def.slug, v)}
        />
      ),
    }),
    col.accessor((r): unknown => r.values[inverseCountSlug(def.slug)] ?? 0, {
      id: inverseCountSlug(def.slug),
      header: `${def.name} count`,
      size: 90,
      meta: { numeric: true },
      cell: (info) => (
        <span className="block px-1 numeric mono text-graphite">
          {String(info.getValue())}
        </span>
      ),
    }),
  ])
}
