import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { isDerived } from '@spaces/core/attributes/relationship'
import type { AttributeOptions } from '@spaces/core/attributes/registry'
import { PickPopover } from '#/components/record/details-add'
import { RailGroup, RailGroupRow } from '#/components/record/record-parts'
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
 * A relationship group in the rail: its name with `+` at the right, each
 * row the link to the far record, ending on its lane; empty, the group's
 * one `Name +` row.
 * - `add` wraps the `+` (or that row) in whatever adds a record — a
 *   `PickPopover`, a create window. Without it the head carries the count.
 */
export function RelationSection({
  label,
  rows,
  mark,
  lane,
  add,
}: {
  label: string
  rows: ReadonlyArray<RelationRow>
  mark?: (row: RelationRow) => ReactNode
  lane?: (row: RelationRow, index: number) => ReactNode
  add?: ((trigger: ReactElement) => ReactNode) | undefined
}) {
  return (
    <RailGroup
      label={label}
      count={rows.length}
      empty={rows.length === 0}
      add={add}
    >
      {rows.map((row, i) => {
        const href = recordPath(row)
        const body = (
          <>
            {mark ? mark(row) : null}
            <span className="min-w-0 flex-1 truncate group-hover/link:underline">
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
          <RailGroupRow key={row.id}>
            {href ? (
              <Link
                to={href}
                className="group/link focus-ring flex min-w-0 flex-1 items-center gap-2.5"
              >
                {body}
              </Link>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-2.5 text-graphite">
                {body}
              </span>
            )}
          </RailGroupRow>
        )
      })}
    </RailGroup>
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
 * A group for every relationship attribute a page draws no group of its
 * own for, either half, read through the resolver. A derived half whose
 * owner is archived stores nothing and is left out.
 * - The `+` writes this record's half; `setValues` puts a derived half's
 *   write on its owner.
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
    <RelationSection
      label={def.name}
      rows={rows}
      add={
        multi || rows.length === 0
          ? (trigger) => (
              <PickPopover
                trigger={trigger}
                placeholder={`Add to ${def.name.toLowerCase()}…`}
                search={search}
                onPick={(hit) =>
                  onAdd(
                    def.slug,
                    multi ? [...rows.map((r) => r.id), hit.id] : hit.id,
                  )
                }
              />
            )
          : undefined
      }
    />
  )
}
