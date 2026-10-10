import { Context, Effect } from 'effect'
import {
  Content,
  Discover,
  Facts,
  Log,
  Spaces,
  definePlugin,
  watchSettingsOf,
} from '@spaces/sdk'
import { manifest } from './manifest.ts'

/**
 * A watch that finds what its settings say it finds. Members of the space
 * get a signal each; every listed candidate goes to `Discover.candidate`,
 * citing the signal when the candidate is a member. `reachForFacts` reads
 * Facts out of the context by hand — the type system would refuse `yield*
 * Facts` against these `uses` — and the host never handed it over.
 */
export default definePlugin({
  manifest,
  jobs: {
    find: (input) =>
      Effect.gen(function* () {
        const settings = yield* watchSettingsOf(manifest.jobs.find, input)
        const log = yield* Log
        if (settings.reachForFacts) {
          yield* log.info('reaching for Facts', { watchId: input.watchId })
          const context = yield* Effect.context<never>()
          const facts = Context.getUnsafe(context, Facts)
          yield* facts.fill({
            entityId: input.spaceId,
            values: { description: 'written by a watch never granted Facts' },
          })
        }
        const brief = yield* (yield* Spaces).brief(input.spaceId)
        const content = yield* Content
        const signalOf = new Map<string, string>()
        for (const member of brief.members) {
          const { signalId } = yield* content.emitSignal({
            _tag: 'signal',
            entityId: member.entityId,
            kind: 'web',
            title: `${member.name} in the news`,
            url: `https://news.example/${member.entityId}`,
          })
          for (const domain of member.domains) signalOf.set(domain, signalId)
        }
        const discover = yield* Discover
        const found: Array<string | null> = []
        for (const c of settings.candidates) {
          const signal = signalOf.get(c.domain)
          const { suggestionId } = yield* discover.candidate({
            spaceId: input.spaceId,
            name: c.name,
            domain: c.domain,
            evidence: c.evidence.map((e) =>
              e.title === undefined
                ? { url: e.url }
                : { url: e.url, title: e.title },
            ),
            ...(signal === undefined ? {} : { refs: [`event:${signal}`] }),
            ...(c.subspaceHint === undefined
              ? {}
              : { subspaceHint: c.subspaceHint }),
          })
          found.push(suggestionId)
        }
        yield* log.info('found', { watchId: input.watchId, found })
        const runs = input.state?.runs
        return { state: { runs: typeof runs === 'number' ? runs + 1 : 1 } }
      }),
  },
})
