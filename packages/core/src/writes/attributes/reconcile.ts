import { isNumericType } from '../../views/filter'
import { reconcileValueIndexes } from '@spaces/db/value-indexes'
import type { ValueIndexOutcome } from '@spaces/db/value-indexes'

/**
 * The one binding of `reconcileValueIndexes()`. `@spaces/db` imports nothing
 * internal, so the numeric-type set is handed in here: the same
 * `isNumericType` that `compileSortKey` branches on. A second copy would make
 * the indexed expression diverge from the emitted one, and the planner would
 * silently never use the index. Callable without a request (boot, tests).
 */
export function reconcileAttributeIndexes(): Promise<ValueIndexOutcome> {
  return reconcileValueIndexes({ isNumericType })
}
