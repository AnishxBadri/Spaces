import { and, eq, or, sql } from 'drizzle-orm'
import { db } from './index.ts'
import { attribute } from './schema/attributes.ts'

/**
 * Per-attribute expression indexes over `entity.values`, reconciled from the
 * registry (SPA-93 — CONTEXT.md, _Open questions_, `values jsonb` indexing
 * strategy, closed here).
 *
 * The recorded answer was "an expression index per attribute, minted at
 * attribute creation behind a filterable/sortable flag, not a GIN over the
 * universe" — a GIN on `values` would index every key of every row to serve
 * the two or three fields anybody actually sorts a twenty-thousand-row
 * object by, and would still not order anything.
 *
 * **Why this is DDL from application code and not a drizzle migration.**
 * The set of indexes is a function of user data — which attributes a fund
 * flagged — not of the schema, so there is no migration that could contain
 * it: it changes when somebody ticks a checkbox. That is also why it is a
 * *reconciler* rather than a create-and-drop pair bolted to the write path.
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so the mint
 * happens after the attribute write commits, which means it can be
 * interrupted between the two; a diff that runs again at every boot heals
 * that by construction, the same shape `seedSystemAttributes()` already
 * uses. A failed mint is logged and returned, never thrown: the attribute
 * is perfectly usable without its index — the list is just as slow as it
 * was before the tick — and the next boot tries again.
 *
 * **Why the index leads with `object_id`.** Every read of this table is
 * scoped to one object and passes that id as a *parameter*
 * (`lib/views/records.ts`). A partial index `where object_id = '<literal>'`
 * would be unusable by a generic plan, and Postgres will not prove a
 * parameter equals a literal. A composite whose first column is `object_id`
 * needs no proof: `object_id = $1` is an ordinary equality on the leading
 * key, which both restricts the scan and collapses the index's pathkeys
 * onto the second column — that collapse is what lets the paged query's
 * `order by <sort key>` be answered by the index instead of by sorting the
 * object. `value-indexes.test.ts` asserts the plan rather than trusting it.
 *
 * **What the second column is.** Exactly the expression the compiled sort
 * key emits (`compileSortKey` in `apps/web/src/lib/views/sql.ts`):
 * `spaces_json_text(values -> '<slug>')` for every type but the three
 * numeric ones, which get `spaces_json_number(...)` because a number sorted
 * as text is not sorted. Those two functions are migration 0041's, and they
 * exist *because* of this file — the coercions used to be inline CASEs, and
 * Postgres refuses a subquery in an index expression, so nothing could be
 * indexed until they moved into the database.
 *
 * `isNumericType` is passed in rather than copied: it lives in
 * `@spaces/core/views/filter` beside the browser evaluator that has to
 * branch the same way, and that module says in so many words that a second
 * copy of the set is a divergence a property test can only report after the
 * fact. packages/db imports nothing internal, so the caller hands it over.
 */

/** Every index this module owns starts with it, and nothing else may. */
export const VALUE_INDEX_PREFIX = 'attr_idx_'

/**
 * One index per flagged attribute, named for the attribute's id — stable,
 * unique, and immune to a rename. The id carries dashes, so the identifier
 * is always quoted.
 */
export const valueIndexName = (attributeId: string) =>
  `${VALUE_INDEX_PREFIX}${attributeId}`

/** Postgres identifier and string literal quoting — slugs are ours, but. */
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`

/**
 * The indexed expression for one attribute, as SQL text. Kept as text and
 * not as a drizzle `SQL` because it is a *definition* — it has to be
 * comparable against `pg_get_indexdef`, and it is interpolated into DDL
 * that cannot take bind parameters.
 */
export const valueIndexExpression = (slug: string, numeric: boolean) =>
  `${numeric ? 'spaces_json_number' : 'spaces_json_text'}("values" -> ${literal(slug)})`

/**
 * Enough of a normalizer to compare our expression against the one
 * `pg_get_indexdef` prints back, which re-parenthesizes, quotes reserved
 * words and spells the `->` argument `'slug'::text`. Whitespace, quotes,
 * parentheses and explicit text casts carry no meaning between those two
 * spellings; everything that does survives.
 */
const normalize = (definition: string) =>
  definition
    .toLowerCase()
    .replace(/::text\b/g, '')
    .replace(/[\s"()]/g, '')

export type ValueIndexOutcome = {
  /** Index names minted this run. */
  created: Array<string>
  /** Index names dropped this run — unflagged, archived, or left invalid. */
  dropped: Array<string>
  /** DDL that failed; the attribute stays usable and the next run retries. */
  failed: Array<{ index: string; error: string }>
}

export type ReconcileOptions = {
  /**
   * `isNumericType` from `@spaces/core/views/filter` — which attribute types
   * the sort key compiles numerically. See the note above on why this is an
   * argument.
   */
  isNumericType: (type: string) => boolean
  /**
   * Runs one DDL statement. Defaults to the pool, which is what makes
   * `CREATE INDEX CONCURRENTLY` legal — it is outside any transaction.
   * Injected by the test that kills a mint.
   */
  execute?: (statement: string) => Promise<unknown>
}

type LiveIndex = { name: string; definition: string; valid: boolean }

/**
 * What the database has. `indisvalid`/`indisready` matter: an interrupted
 * `CREATE INDEX CONCURRENTLY` leaves an invalid index behind, which the
 * planner ignores and `IF NOT EXISTS` would happily skip forever. Dropping
 * it is how "the next boot retries" stays true for the concurrent build's
 * own failure mode and not just for ours.
 */
async function liveIndexes(): Promise<Array<LiveIndex>> {
  const result = await db.execute<LiveIndex>(sql`
    select
      c.relname as name,
      pg_get_indexdef(i.indexrelid) as definition,
      (i.indisvalid and i.indisready) as valid
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.relname = 'entity'
      and n.nspname = current_schema()
      and c.relname like ${`${VALUE_INDEX_PREFIX}%`}
  `)
  return result.rows
}

/**
 * Diff `pg_indexes` against the flagged, unarchived attributes and make the
 * database match. Idempotent: a second run issues nothing.
 *
 * Call it at boot beside `seedSystemAttributes()`, and after an attribute
 * create or update **commits** — never inside that transaction.
 */
export async function reconcileValueIndexes(
  options: ReconcileOptions,
): Promise<ValueIndexOutcome> {
  const run =
    options.execute ?? ((statement: string) => db.execute(sql.raw(statement)))

  // Flagged and live. Either flag mints the one index: a reader who can
  // filter on a field sorts by it next, and the two capabilities want the
  // same btree. The columns stay apart for the reconciler's own sake and
  // for whatever later UI separates them.
  const wanted = await db.execute<{ id: string; slug: string; type: string }>(
    sql`select ${attribute.id} as id, ${attribute.slug} as slug, ${attribute.type}::text as type
        from ${attribute}
        where ${and(
          eq(attribute.archived, false),
          or(eq(attribute.filterable, true), eq(attribute.sortable, true)),
        )}`,
  )

  const desired = new Map(
    wanted.rows.map((a) => [
      valueIndexName(a.id),
      valueIndexExpression(a.slug, options.isNumericType(a.type)),
    ]),
  )
  const live = await liveIndexes()

  const created: Array<string> = []
  const dropped: Array<string> = []
  const failed: Array<{ index: string; error: string }> = []

  const drop = async (name: string) => {
    try {
      await run(`DROP INDEX CONCURRENTLY IF EXISTS ${ident(name)}`)
      dropped.push(name)
    } catch (cause) {
      failed.push({ index: name, error: String(cause) })
    }
  }

  const standing = new Set<string>()
  for (const index of live) {
    const want = desired.get(index.name)
    // Orphan (flag cleared, attribute archived or deleted), a leftover from
    // an interrupted concurrent build, or — belt and braces — an index whose
    // expression no longer matches what the query emits.
    if (
      want === undefined ||
      !index.valid ||
      !normalize(index.definition).includes(normalize(want))
    ) {
      await drop(index.name)
      continue
    }
    standing.add(index.name)
  }

  for (const [name, expression] of desired) {
    if (standing.has(name)) continue
    try {
      await run(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ident(name)} ON "entity" ("object_id", ${expression})`,
      )
      created.push(name)
    } catch (cause) {
      // Logged, not thrown: the attribute is usable unindexed, and the next
      // boot reconciles again.
      failed.push({ index: name, error: String(cause) })
    }
  }

  if (created.length > 0 || dropped.length > 0)
    console.log(
      `[value-indexes] +${created.length} -${dropped.length} on entity.values`,
    )
  for (const f of failed)
    console.error(`[value-indexes] ${f.index} failed: ${f.error}`)

  return { created, dropped, failed }
}
