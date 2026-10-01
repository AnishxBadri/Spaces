import { Effect } from 'effect'
import { z } from 'zod'
import {
  Facts,
  Http,
  Identity,
  JobPermanent,
  JobRetryable,
  Log,
  Read,
  Receipts,
  definePlugin,
  responseJson,
} from '@spaces/sdk'
import { toClaims } from './map.ts'
import { manifest } from './manifest.ts'

/** A stand-in provider; the test scripts its responses (HttpTest). */
export const PROVIDER_URL = 'https://provider.example/v1/organizations/enrich'

export default definePlugin({
  manifest,
  jobs: {
    echo: (input) => Effect.succeed(input).pipe(Effect.asVoid),
    enrich: {
      // D52: the job calls ports, each port writes through its lane at once,
      // and the next call uses what the last one returned.
      run: ({ entityId }) =>
        Effect.gen(function* () {
          const record = yield* (yield* Read).entity(entityId)
          const domain = record?.keys.domain.at(0)
          if (domain === undefined) {
            return yield* new JobPermanent({
              reason: `${entityId} has no domain to enrich from`,
            })
          }
          const url = `${PROVIDER_URL}?domain=${encodeURIComponent(domain)}`
          const response = yield* (yield* Http).request({
            method: 'GET',
            url,
            headers: { accept: 'application/json' },
          })
          if (response.status !== 200) {
            return yield* new JobRetryable({
              reason: `${url} answered ${response.status}`,
            })
          }
          const raw = yield* responseJson(response, url).pipe(
            Effect.flatMap((body) =>
              Effect.try({
                try: () => z.json().parse(body),
                catch: () => new JobPermanent({ reason: `${url}: not JSON` }),
              }),
            ),
          )
          const claims = yield* Effect.try({
            try: () => toClaims(raw),
            catch: () =>
              new JobPermanent({
                reason: `${url} did not return an organization`,
              }),
          })

          const { entityId: resolved } = yield* (yield* Identity).resolve(
            claims.identity,
          )
          const { receiptId } = yield* (yield* Receipts).store(
            claims.receipt(resolved),
          )
          const { conflicts } = yield* (yield* Facts).fill(
            claims.facts(resolved, receiptId),
          )
          yield* (yield* Log).info('enriched', {
            entityId: resolved,
            receiptId,
            conflicts: conflicts.map((c) => c.slug),
          })
        }),
      // One organization lookup costs one provider credit (D53).
      cost: ({ entityIds }) => ({ credits: entityIds.length }),
    },
  },
})
