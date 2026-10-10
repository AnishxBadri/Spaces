import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import { searchPassagesProgram } from './passages'
import type { Passage } from './passages'

/** `searchPassages`'s body, out of `lib/server/` so a test can call it. */
export async function searchPassagesHandler(data: {
  q: string
}): Promise<Array<Passage>> {
  const u = await requireUser()
  return effectFn(searchPassagesProgram)({ userId: u.id, q: data.q })
}
