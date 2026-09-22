import { isNumericType } from '@spaces/core/views/filter'
import { reconcileValueIndexes } from '@spaces/db/value-indexes'
import type { ValueIndexOutcome } from '@spaces/db/value-indexes'

/**
 * The app's one binding of `reconcileValueIndexes()` (SPA-93).
 *
 * `packages/db` owns the diff because it needs `pg_indexes` and DDL and
 * because boot lives there, but it imports nothing internal — so the one
 * thing it cannot know, which attribute types the sort key compiles
 * numerically, is handed to it here from `@spaces/core/views/filter`. That
 * is the same `isNumericType` the browser evaluator and `compileSortKey`
 * branch on, which is the point: a second copy of the set would be a
 * divergence between the indexed expression and the emitted one, and the
 * only symptom would be an index the planner silently never uses.
 *
 * Deliberately outside `lib/server/`: `lib/server-fns.ts` is a
 * client-imported barrel and only `createServerFn().handler()` bodies are
 * stripped (CLAUDE.md, traps), so a plain export from a `lib/server/*.ts`
 * module ships to the browser. Boot and the tests call this without a
 * request.
 */
export function reconcileAttributeIndexes(): Promise<ValueIndexOutcome> {
  return reconcileValueIndexes({ isNumericType })
}
