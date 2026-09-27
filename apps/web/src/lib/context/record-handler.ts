import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import { DEFAULT_BUDGET_CHARS, recordContextProgram } from './record'
import type { RecordContext } from './record'

/**
 * `getRecordContext`'s body (SPA-18), out of `lib/server/` so a test can call
 * it with the request stubbed (SPA-23 asserts the MCP `get_context` tool
 * returns this, byte for byte). The session user and the clock are stamped
 * here, at the boundary; the program underneath stays deterministic on
 * (data, asOf, user).
 */
export async function getRecordContextHandler(data: {
  entityId: string
  budgetChars?: number | undefined
  similar?: boolean | undefined
}): Promise<RecordContext> {
  const u = await requireUser()
  return effectFn(recordContextProgram)({
    entityId: data.entityId,
    user: { id: u.id },
    asOf: new Date().toISOString(),
    budgetChars: data.budgetChars ?? DEFAULT_BUDGET_CHARS,
    similar: data.similar === true,
  })
}
