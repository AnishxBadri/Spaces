import { Effect, Schema } from 'effect'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, entity, objectDef, view } from '@spaces/db/schema'
import { CORE_OBJECTS } from '@spaces/core/attributes/registry'
import { compileConditions } from './sql'
import { entityValuesResolver } from './resolve'
import { listScope } from './scope'
import type { SQL } from 'drizzle-orm'
import type { FieldResolver } from './sql'
import type { Condition } from '@spaces/core/views/filter'
import type { ListScope } from './scope'

/**
 * How many records each saved view holds, counted in Postgres (SPA-162) —
 * the number a `ViewChip` prints after its name, for every chip on the bar,
 * including the ones whose rows the page has never loaded.
 *
 * **One predicate, not two.** The count is `compileConditions` over the
 * object's live registry, inside `listScope` — exactly the `where` the list
 * page filters by (`records.ts`, `directory.ts`), so a chip cannot promise a
 * number the table then contradicts. There is no second filter semantics
 * here, and `counts.test.ts` walks every op in `OP_LABELS` to hold it.
 *
 * **Refusing, not widening.** `compileConditions` drops a condition whose
 * slug the resolver returns null for (an archived or never-declared
 * attribute). For the records page that is the decided behaviour — a stale
 * view widens rather than empties. For a *count* it would be a number from a
 * partial `where`, printed as though it were the view's: so every slug is
 * resolved here first, and a view with any unresolvable condition comes back
 * `{ count: null, reason }` and is never compiled. `compileConditions` is
 * left exactly as it is.
 *
 * **One round trip for the whole bar.** A single `select` over the scope
 * with one `count(*) filter (where …)` per countable view: one scan of the
 * object's rows however many chips there are, rather than N queries that
 * each scan it again. The chips arrive together, and the query is as cheap
 * with twelve views as with one.
 *
 * It lives outside `lib/server/` for the reason `records.ts` does: the server
 * fn that wraps it is re-exported by a client-imported barrel, so the test
 * calls this program directly.
 */

export class ViewCountFailed extends Schema.TaggedError<ViewCountFailed>()(
  'ViewCountFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ViewCountFailed({ cause }),
  })

/** A chip's number, or why it has none. */
export type ViewCount = { count: number } | { count: null; reason: string }

/**
 * The page's current, unsaved conditions for the view it is showing, so the
 * active chip moves with the table as the Filter popover edits it. Counted
 * through the same program, never stored.
 */
export type LiveConditions = { viewId: string; filter: Array<Condition> }

/** Which list an object row's records are shown on — the page the chip opens. */
export const scopeOf = (object: { id: string; slug: string }): ListScope => {
  if (object.slug === CORE_OBJECTS.company.slug) return { kind: 'company' }
  if (object.slug === CORE_OBJECTS.person.slug) return { kind: 'person' }
  if (object.slug === CORE_OBJECTS.deal.slug) return { kind: 'deal' }
  return { kind: 'custom', objectId: object.id }
}

/**
 * The object's live registry as the list page reads it — the resolver its
 * `where` is compiled with — plus the archived attributes' names, which only
 * name a reason. Shared with the column run (SPA-122), which walks exactly
 * the rows a chip counts.
 */
export type ViewLens = {
  resolve: FieldResolver
  archivedName: ReadonlyMap<string, string>
}

export const viewLensProgram = Effect.fn('viewLensProgram')(function* (
  objectId: string,
): Effect.fn.Return<ViewLens, ViewCountFailed> {
  // Every attribute, archived included: the live ones build the resolver
  // (exactly as the list page does), the archived ones only name a reason.
  const attributes = yield* query(() =>
    db
      .select({
        slug: attribute.slug,
        name: attribute.name,
        type: attribute.type,
        archived: attribute.archived,
      })
      .from(attribute)
      .where(eq(attribute.objectId, objectId)),
  )
  return {
    resolve: entityValuesResolver(attributes.filter((a) => !a.archived)),
    archivedName: new Map(
      attributes.filter((a) => a.archived).map((a) => [a.slug, a.name]),
    ),
  }
})

/**
 * A view's conditions compiled to the list page's `where` — or, when any
 * slug does not resolve, the condition that would have been dropped, named
 * by its archived attribute when there is one, and never compiled. A caller
 * that counts or walks rows refuses on `lost`; it never widens.
 */
export function compileViewWhere(
  conditions: ReadonlyArray<Condition>,
  lens: ViewLens,
): { where: SQL } | { lost: string; archived: boolean } {
  const lost = conditions.find((c) => lens.resolve(c.slug) === null)
  if (lost) {
    const name = lens.archivedName.get(lost.slug)
    return name === undefined
      ? { lost: lost.slug, archived: false }
      : { lost: name, archived: true }
  }
  return {
    where: compileConditions([...conditions], lens.resolve) ?? sql`true`,
  }
}

export const countViewsProgram = Effect.fn('countViewsProgram')(function* (
  objectId: string,
  viewIds: Array<string>,
  userId: string,
  live?: LiveConditions,
): Effect.fn.Return<Record<string, ViewCount>, ViewCountFailed> {
  if (viewIds.length === 0) return {}
  const object = yield* query(() =>
    db
      .select({ id: objectDef.id, slug: objectDef.slug })
      .from(objectDef)
      .where(eq(objectDef.id, objectId))
      .then((rows) => rows.at(0)),
  )
  if (!object)
    return Object.fromEntries(
      viewIds.map((id) => [id, { count: null, reason: 'Object not found' }]),
    )

  // The same visibility `listViewsProgram` applies: shared, or the caller's
  // own — and on this object, so an id cannot reach another list's view.
  const views = yield* query(() =>
    db
      .select({ id: view.id, filter: view.filter })
      .from(view)
      .where(
        and(
          eq(view.surface, 'object'),
          eq(view.objectId, objectId),
          inArray(view.id, viewIds),
          or(eq(view.visibility, 'shared'), eq(view.createdBy, userId)),
        ),
      ),
  )
  const lens = yield* viewLensProgram(objectId)

  const out: Record<string, ViewCount> = {}
  const countable: Array<{ id: string; where: SQL }> = []
  const byId = new Map(views.map((v) => [v.id, v.filter]))
  for (const id of viewIds) {
    const stored = byId.get(id)
    if (stored === undefined) {
      out[id] = { count: null, reason: 'View not found' }
      continue
    }
    const conditions = live?.viewId === id ? live.filter : stored
    // Resolve before compiling — `compileConditions` would silently drop
    // the condition and count a wider set than the view names (see above).
    const compiled = compileViewWhere(conditions, lens)
    if ('lost' in compiled) {
      out[id] = {
        count: null,
        reason: `Not counted: it filters on “${compiled.lost}”, which ${compiled.archived ? 'is archived' : 'this list no longer has'}`,
      }
      continue
    }
    countable.push({ id, where: compiled.where })
  }
  if (countable.length === 0) return out

  const selection = Object.fromEntries(
    countable.map((c, i) => [
      `c${i}`,
      sql<number>`(count(*) filter (where ${c.where}))::int`,
    ]),
  )
  const row = yield* query(() =>
    db
      .select(selection)
      .from(entity)
      .where(listScope(scopeOf(object)))
      .then((rows) => rows.at(0)),
  )
  countable.forEach((c, i) => {
    out[c.id] = { count: row?.[`c${i}`] ?? 0 }
  })
  return out
})
