/**
 * The queue, stood in for. The test databases carry no `pgboss` schema, so a
 * real `enqueue` spends a connection attempt to log a stack trace and answer
 * `null`.
 *
 * A test file opts in with one line:
 *
 * ```ts
 * vi.mock('#/lib/queue', () => import('#/test/queue-stub'))
 * ```
 *
 * and `enqueued` is then the record of what was sent: the only way to observe
 * it, since `enqueue` answers `null` whether it was called or not.
 *
 * Module state, scoped to the file it is mocked into. Clear it in a
 * `beforeEach` when the count matters.
 */

export const enqueued = new Array<{
  name: string
  data: Record<string, unknown>
  options?: { singletonKey?: string }
}>()

/**
 * The `exclusive` policy, stood in for: a stub job never runs, so
 * one sent with a `singletonKey` stays queued for the life of the file, and
 * a second send with the same key on the same queue is refused exactly as
 * pg-boss refuses it — `null`, nothing recorded. Only a send that asks for a
 * key can be refused, so every caller that never passes one is unaffected.
 */
export function enqueue(
  name: string,
  data: Record<string, unknown>,
  options?: { singletonKey?: string },
): Promise<string | null> {
  const key = options?.singletonKey
  if (
    key !== undefined &&
    enqueued.some((e) => e.name === name && e.options?.singletonKey === key)
  )
    return Promise.resolve(null)
  enqueued.push(
    options === undefined ? { name, data } : { name, data, options },
  )
  return Promise.resolve('stub-job')
}

/** Every stub job is still queued: it was sent and nothing ever works it. */
export function jobsByKey(
  name: string,
  key: string,
): Promise<
  Array<{ state: 'created'; output: object | null; createdOn: Date }>
> {
  return Promise.resolve(
    enqueued
      .filter((e) => e.name === name && e.options?.singletonKey === key)
      .map(() => ({ state: 'created', output: null, createdOn: new Date(0) })),
  )
}
