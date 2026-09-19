import { describe, expect, it } from 'vitest'
import {
  readPublicSchemaCounts,
  writeIsolationProbe,
} from './file-isolation.ts'

/**
 * Half of the per-file isolation regression test (SPA-145); the other half is
 * `file-isolation-b.test.ts`, identical apart from its tag.
 *
 * The pair is here and not in apps/web because this suite runs with
 * `fileParallelism: false` against one database, so "the other file" is a
 * fact and not a coin flip: whichever of the two vitest orders second finds
 * the first one's attribute, view and duplicate_candidate already written and
 * asserts they are gone. Comment out the `truncatePublicTables` call in
 * `vitest.setup.ts` and that file goes red. In apps/web the four workers have
 * four databases, so a pair there would prove nothing about ordering.
 *
 * Neither half cleans up after itself. That is the point: the next file's
 * setup does, and a second run of the suite starts as clean as the first.
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
