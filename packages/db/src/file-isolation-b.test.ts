import { describe, expect, it } from 'vitest'
import {
  readPublicSchemaCounts,
  writeIsolationProbe,
} from './file-isolation.ts'

/** The other half of the pair — see `file-isolation-a.test.ts`. */
describe('file isolation (b)', () => {
  it('starts on an empty public schema, with the journal untouched', async () => {
    expect(await readPublicSchemaCounts()).toEqual({
      entities: 0,
      attributes: 0,
      views: 0,
      duplicateCandidates: 0,
      journal: expect.any(Number),
    })
    expect((await readPublicSchemaCounts()).journal).toBeGreaterThan(0)

    await writeIsolationProbe('b')

    const after = await readPublicSchemaCounts()
    expect(after).toMatchObject({
      entities: 2,
      attributes: 1,
      views: 1,
      duplicateCandidates: 1,
    })
  })
})
