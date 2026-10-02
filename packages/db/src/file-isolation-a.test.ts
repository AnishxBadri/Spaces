import { describe, expect, it } from 'vitest'
import {
  readPublicSchemaCounts,
  writeIsolationProbe,
} from './file-isolation.ts'

/**
 * Half of the per-file isolation regression test; (b) is identical but for
 * its tag.
 * - It lives in the single-database suite, so whichever half runs second
 *   finds the first's rows written and asserts they are gone. Remove the
 *   `truncatePublicTables` call from the setup and that half goes red.
 * - Neither half cleans up after itself. That is the point.
 */
describe('file isolation (a)', () => {
  it('starts on an empty public schema, with the journal untouched', async () => {
    expect(await readPublicSchemaCounts()).toEqual({
      entities: 0,
      attributes: 0,
      views: 0,
      duplicateCandidates: 0,
      journal: expect.any(Number),
    })
    expect((await readPublicSchemaCounts()).journal).toBeGreaterThan(0)

    await writeIsolationProbe('a')

    const after = await readPublicSchemaCounts()
    expect(after).toMatchObject({
      entities: 2,
      attributes: 1,
      views: 1,
      duplicateCandidates: 1,
    })
  })
})
