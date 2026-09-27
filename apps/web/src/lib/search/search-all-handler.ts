import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import { searchAllProgram } from './query'
import type { SearchHit } from './query'

/**
 * `searchAll`'s body — Cmd-K's request half — out of `lib/server/` so a test
 * can call it with the session stubbed (CLAUDE.md, SPA-155). SPA-28 asserts
 * the MCP `search_records` tool answers exactly this for the same user and
 * query; the fused query itself, and every invariant it keeps, is
 * `searchAllProgram` in `./query.ts`.
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
