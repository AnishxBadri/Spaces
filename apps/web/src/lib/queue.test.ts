import { describe, expectTypeOf, it } from 'vitest'
import { enqueue } from './queue'

/**
 * `enqueue()`'s queue type, checked by the compiler: a plugin job's
 * `plugin.<id>.<job>` is accepted, and a misspelt core name is still an
 * error. Nothing is sent — `expectTypeOf` never calls `enqueue`.
 */
describe('enqueue', () => {
  it('takes a core queue or a plugin queue, and refuses a misspelt core name', () => {
    expectTypeOf(enqueue).toBeCallableWith('document.extract', {})
    expectTypeOf(enqueue).toBeCallableWith('plugin.echo.echo', {
      entityId: 'e-1',
    })
    expectTypeOf(enqueue).toBeCallableWith(
      'plugin.apollo.enrich.interactive',
      {},
    )
    // @ts-expect-error — `document.extrct` is neither a QueueName nor plugin.*
    expectTypeOf(enqueue).toBeCallableWith('document.extrct', {})
    // @ts-expect-error — a plugin queue needs both the id and the job
    expectTypeOf(enqueue).toBeCallableWith('plugin.echo', {})
  })
})
