import { Effect } from 'effect'
import {
  DEFAULT_BUDGET_CHARS,
  recordContextProgram,
} from '@spaces/core/writes/context/record'
import type {
  RecordContext,
  RecordContextInput,
} from '@spaces/core/writes/context/record'
import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import { SimilarLaneLive } from './similar'

/**
 * `getRecordContext`'s body (SPA-18), out of `lib/server/` so a test can call
 * it with the request stubbed (SPA-23 asserts the MCP `get_context` tool
 * returns this, byte for byte). The session user and the clock are stamped
 * here, at the boundary; the program underneath stays deterministic on
 * (data, asOf, user). The program is core's since SPA-182 and declares the
 * `SimilarLane` service; this boundary provides the live lane.
 */
const recordContext = (input: RecordContextInput) =>
  recordContextProgram(input).pipe(Effect.provide(SimilarLaneLive))

export async function getRecordContextHandler(data: {
  entityId: string
  budgetChars?: number | undefined
  similar?: boolean | undefined
}): Promise<RecordContext> {
  const u = await requireUser()
  return effectFn(recordContext)({
    entityId: data.entityId,
    user: { id: u.id },
    asOf: new Date().toISOString(),
    budgetChars: data.budgetChars ?? DEFAULT_BUDGET_CHARS,
    similar: data.similar === true,
  })
}
