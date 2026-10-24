import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import { searchAllProgram } from './query'
import type { SearchHit } from './query'

/**
 * `searchAll`'s body, outside the server-fn module so a test can call it with
 * the session stubbed. MCP's `search_records` answers exactly this for the
 * same user and query; the fused query and its invariants are
 * `searchAllProgram`.
 */
export async function searchAllHandler(data: {
  q: string
  semantic?: boolean | undefined
}): Promise<Array<SearchHit>> {
  const u = await requireUser()
  return effectFn(searchAllProgram)({
    userId: u.id,
    q: data.q,
    semantic: data.semantic === true,
  })
}
