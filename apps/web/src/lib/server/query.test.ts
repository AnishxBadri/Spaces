import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { ServerQueryFailed, serverQuery } from './query'

/**
 * A client reads a rejected call's `message` and nothing else, so a failed
 * query must still say what the driver said.
 */
describe('serverQuery', () => {
  it('answers what the call answers', async () => {
    await expect(
      Effect.runPromise(serverQuery(() => Promise.resolve(3))),
    ).resolves.toBe(3)
  })

  it('rejects with ServerQueryFailed carrying the cause’s message', async () => {
    const cause = new Error('Failed query: select 1')
    const refused = Effect.runPromise(serverQuery(() => Promise.reject(cause)))
    await expect(refused).rejects.toBeInstanceOf(ServerQueryFailed)
    await expect(refused).rejects.toMatchObject({
      message: 'Failed query: select 1',
      cause,
    })
  })

  it('leads the message with a prefix when given one', async () => {
    const refused = Effect.runPromise(
      serverQuery(
        () => Promise.reject(new Error('boom')),
        'Registry read failed',
      ),
    )
    await expect(refused).rejects.toThrow('Registry read failed: boom')
  })

  it('prints a cause that is not an Error', async () => {
    const refused = Effect.runPromise(
       
      serverQuery(() => Promise.reject('gone')),
    )
    await expect(refused).rejects.toThrow('gone')
  })
})
