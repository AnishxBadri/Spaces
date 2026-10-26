import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import type { ReactNode } from 'react'
import { isDerived } from '@spaces/core/attributes/relationship'
import type { AttributeOptions } from '@spaces/core/attributes/registry'
import { DetailsPickRow } from '#/components/record/details-add'
import { RailItem, RailSection } from '#/components/record/record-parts'
import { recordPath } from '#/lib/record-path'
import { searchEntities } from '#/lib/server-fns'

/** A record on the far side of a relationship, as the resolver names it. */
export type RelationRow = {
  id: string
  name: string
  kind: string
  objectSlug: string | null
}

/** One attribute of a relationship as the record reads it. */
export type RelationHalfRow = {
  slug: string
  derived: boolean
  items: ReadonlyArray<RelationRow>
}

/**
 * A record's values with each derived half filled from the resolver, so a
 * property row reads — and writes back — the inverse as if it were stored.
 */
export function withDerived<TValue>(
  values: Readonly<Record<string, TValue>>,
  halves: ReadonlyArray<RelationHalfRow & { value: TValue }>,
): Record<string, TValue> {
  return {
    ...values,
    ...Object.fromEntries(
      halves.filter((h) => h.derived).map((h) => [h.slug, h.value]),
    ),
  }
}

/** The rows a half holds, either side; none when the record holds none. */
export function relationRows(
  halves: ReadonlyArray<RelationHalfRow>,
  slug: string,
  derived: boolean,
): ReadonlyArray<RelationRow> {
  return (
    halves.find((h) => h.slug === slug && h.derived === derived)?.items ?? []
  )
}

/**
 * A relationship section in the details column: the count once in the head,
 * each row the link to the far record, ending on its lane.
 * - `children` is the section's composer row; with no rows it is the
 *   section's one `Name +` row.
 */
export function RelationSection({
  label,
  rows,
  mark,
  lane,
  children,
}: {
  label: string
  rows: ReadonlyArray<RelationRow>
  mark?: (row: RelationRow) => ReactNode
  lane?: (row: RelationRow, index: number) => ReactNode
  children?: ReactNode
}) {
  return (
    <RailSection
      label={label}
      meta={`${rows.length}`}
      empty={rows.length === 0 && Boolean(children)}
    >
      {rows.map((row, i) => {
        const href = recordPath(row)
        const body = (
          <>
            {mark ? mark(row) : null}
            <span className="min-w-0 flex-1 truncate group-hover/row:underline">
              {row.name}
            </span>
            {lane ? (
              <span className="flex max-w-30 shrink-0 items-center truncate">
                {lane(row, i)}
              </span>
            ) : null}
          </>
        )
        return (
          <RailItem key={row.id}>
            {href ? (
              <Link
                to={href}
                className="group/row focus-ring flex min-w-0 flex-1 items-center gap-2.5"
              >
                {body}
              </Link>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-2.5 text-graphite">
                {body}
              </span>
            )}
          </RailItem>
        )
      })}
      {children}
    </RailSection>
  )
}

type PairDef = {
  slug: string
  name: string
  type: string
  options: AttributeOptions
  pair: { archived: boolean } | null
}

/**
 * A section for every relationship attribute a page draws no section of its
 * own for, either half, read through the resolver. A derived half whose
 * owner is archived stores nothing and is left out.
 * - The add row writes this record's half; `setValues` puts a derived
 *   half's write on its owner.
 */
export function RelationSections({
  defs,
  halves,
  skip = [],
  onAdd,
}: {
  defs: ReadonlyArray<PairDef>
  halves: ReadonlyArray<RelationHalfRow>
  skip?: ReadonlyArray<string>
  onAdd: (slug: string, value: string | Array<string>) => Promise<void>
}) {
  const shown = defs.filter(
    (d) =>
      d.type === 'record_reference' &&
      d.options.inverseOf !== undefined &&
      d.pair !== null &&
      !(isDerived(d) && d.pair.archived) &&
      !skip.includes(d.slug),
  )
  return (
    <>
      {shown.map((def) => (
        <PairSection
          key={def.slug}
          def={def}
          rows={relationRows(halves, def.slug, isDerived(def))}
          onAdd={onAdd}
        />
      ))}
    </>
  )
}

function PairSection({
  def,
  rows,
  onAdd,
}: {
  def: PairDef
  rows: ReadonlyArray<RelationRow>
  onAdd: (slug: string, value: string | Array<string>) => Promise<void>
}) {
  const multi = def.options.multi === true
  const targetObjectId = def.options.targetObjectId
  const targetKind = def.options.targetKind
  const search = useCallback(
    async (q: string) => {
      const on = new Set(rows.map((r) => r.id))
      const hits = await searchEntities({
        data:
          targetObjectId !== undefined
            ? { q, objectId: targetObjectId }
            : targetKind !== undefined
              ? { q, kinds: [targetKind] }
              : { q },
      })
      return hits.filter((h) => !on.has(h.id))
    },
    [rows, targetKind, targetObjectId],
  )
  return (
    <RelationSection label={def.name} rows={rows}>
      {multi || rows.length === 0 ? (
        <DetailsPickRow
          label={`Add to ${def.name.toLowerCase()}…`}
          placeholder="Name…"
          search={search}
          onPick={(hit) =>
            onAdd(def.slug, multi ? [...rows.map((r) => r.id), hit.id] : hit.id)
          }
        />
      ) : null}
    </RelationSection>
  )
}
