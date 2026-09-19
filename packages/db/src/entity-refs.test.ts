import { describe, expect, it } from 'vitest'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import * as schema from './schema'
import { ENTITY_REFS } from './entity-refs'

/**
 * Discover every column that references an entity, from drizzle's own FK
 * metadata. Direct: target is entity.id. One step removed: target is a side
 * table's entity_id PK (note, space, document, ...). A side table's own
 * single-column PK is excluded — that row *is* the entity.
 */
function entityRefColumnsFromSchema(): Set<string> {
  const tables = Object.values<unknown>(schema).filter(
    (t): t is PgTable => t instanceof PgTable,
  )
  const entityName = getTableConfig(schema.entity).name

  // side tables: single-column PK that is itself an FK to entity.id
  const sideTables = new Set<string>()
  for (const t of tables) {
    const c = getTableConfig(t)
    const pkCols = c.columns.filter((col) => col.primary)
    if (pkCols.length !== 1) continue
    const pk = pkCols[0]
    const fk = c.foreignKeys.find((f) =>
      f.reference().columns.some((col) => col.name === pk.name),
    )
    if (fk && getTableConfig(fk.reference().foreignTable).name === entityName)
      sideTables.add(c.name)
  }

  const out = new Set<string>()
  for (const t of tables) {
    const c = getTableConfig(t)
    const singlePk =
      c.columns.filter((col) => col.primary).length === 1
        ? c.columns.find((col) => col.primary)
        : undefined
    for (const fk of c.foreignKeys) {
      const r = fk.reference()
      const target = getTableConfig(r.foreignTable).name
      const targetsEntity =
        target === entityName ||
        (sideTables.has(target) && r.foreignColumns.every((fc) => fc.primary))
      if (!targetsEntity) continue
      for (const col of r.columns) {
        if (singlePk && col.name === singlePk.name) continue
        out.add(`${c.name}.${col.name}`)
      }
    }
  }
  return out
}

/** The `del` vocabulary, as `DeleteStrategy` spells it. */
const DELETE_KINDS = new Set(['cascade', 'block', 'orphan', 'none'])

function registryColumns(): Set<string> {
  return new Set(
    ENTITY_REFS.filter((r) => !r.noFk).map(
      (r) => `${getTableConfig(r.table).name}.${r.column.name}`,
    ),
  )
}

describe('ENTITY_REFS', () => {
  it('lists every FK column that references an entity, and nothing else', () => {
    const fromSchema = entityRefColumnsFromSchema()
    const fromRegistry = registryColumns()
    const missing = [...fromSchema].filter((k) => !fromRegistry.has(k)).sort()
    const stale = [...fromRegistry].filter((k) => !fromSchema.has(k)).sort()
    expect(
      missing,
      `columns referencing an entity with no ENTITY_REFS entry — merge and the assembler would miss them`,
    ).toEqual([])
    expect(stale, `ENTITY_REFS entries whose column no longer exists`).toEqual(
      [],
    )
  })

  it('has unique keys and one column per entry', () => {
    const keys = ENTITY_REFS.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    const cols = [...registryColumns(), 'entity.merged_into_id']
    expect(new Set(cols).size).toBe(ENTITY_REFS.length)
  })

  it('keeps the hand-asserted no-FK columns real', () => {
    for (const r of ENTITY_REFS.filter((x) => x.noFk)) {
      const c = getTableConfig(r.table)
      expect(c.columns.map((col) => col.name)).toContain(r.column.name)
    }
  })

  it('makes every entry declare what delete does with it', () => {
    // A `del` the type system never saw — a hand-written entry, a merge from
    // a branch that predates SPA-77 — reaches the delete executor as
    // `undefined` and falls through its switch, leaving the rows dangling.
    // Named keys, because the point is to say which entry to go and fix.
    const undeclared = ENTITY_REFS.filter((r) => {
      const del: unknown = r.del
      return (
        typeof del !== 'object' ||
        del === null ||
        !('kind' in del) ||
        !DELETE_KINDS.has(String(del.kind))
      )
    }).map((r) => r.key)
    expect(
      undeclared,
      `ENTITY_REFS entries with no \`del\` strategy — deleteEntity would walk past these rows`,
    ).toEqual([])
  })

  it('makes a refusal say why, and only nulls nullable columns', () => {
    for (const r of ENTITY_REFS) {
      // The reason is what the caller is told when the delete is refused, so
      // an empty one is a refusal nobody can act on.
      if (r.del.kind === 'block') expect(r.del.reason.length).toBeGreaterThan(0)
      // `orphan` writes NULL into the column. On a NOT NULL column that is a
      // constraint violation at delete time rather than a design choice.
      if (r.del.kind === 'orphan') expect(r.column.notNull).toBe(false)
    }
  })

  it('never lets a merge-only column pretend to be context, or vice versa', () => {
    // Every entry states both consumers; `context: null` is a choice.
    for (const r of ENTITY_REFS) {
      expect(r.merge.kind).toBeTruthy()
      expect(r).toHaveProperty('context')
    }
  })
})
