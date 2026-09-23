/**
 * The queue, stood in for (SPA-113). `#/lib/queue`'s `enqueue` builds a
 * pg-boss sender from `DATABASE_URL` on first use, and the test databases
 * carry no `pgboss` schema — the harness migrates `public` and nothing else —
 * so every enqueue a test triggers spends a connection attempt to log a stack
 * trace and answer `null`. That was tolerable while only `reExtractDocument`
 * enqueued; since the birth of a document does it, every document fixture in
 * the suite would print one.
 *
 * A test file opts in with one line:
 *
 * ```ts
 * vi.mock('#/lib/queue', () => import('#/test/queue-stub'))
 * ```
 *
 * and `enqueued` is then the record of what was sent — which is the only way
 * to observe the decision at all, since `enqueue` swallows its own failures
 * by design and answers `null` whether it was called or not.
 *
 * It is module state, so it survives the file it is mocked into and nothing
 * else: each vitest worker is its own process and each file its own module
 * graph. Clear it in a `beforeEach` when the count matters.
 */

export const enqueued = new Array<{
  name: string
  data: Record<string, unknown>
  options?: { singletonKey?: string }
}>()

/**
 * The `exclusive` policy, stood in for (SPA-90): a stub job never runs, so
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
