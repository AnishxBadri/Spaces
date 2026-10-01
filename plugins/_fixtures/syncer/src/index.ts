import { Effect } from 'effect'
import { z } from 'zod'
import {
  Content,
  Http,
  Identity,
  JobPermanent,
  JobRetryable,
  Log,
  definePlugin,
  responseJson,
} from '@spaces/sdk'
import type { EntityId, IdentityClaim } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/** A stand-in mail provider; the test scripts its pages (HttpTest). */
export const MESSAGES_URL = 'https://mail.example/v1/messages'

const pageUrl = (cursor: string | null) =>
  cursor === null
    ? MESSAGES_URL
    : `${MESSAGES_URL}?cursor=${encodeURIComponent(cursor)}`

const address = z.object({
  email: z.string().min(1),
  name: z.string().min(1).nullish(),
})

/** One page of the provider's answer — the fields this fixture reads. */
const messagesPage = z.object({
  messages: z.array(
    z.object({
      id: z.string().min(1),
      threadId: z.string().min(1).nullish(),
      subject: z.string().nullish(),
      date: z.string().min(1),
      from: address,
      to: z.array(address).default([]),
      snippet: z.string().nullish(),
    }),
  ),
  nextCursor: z.string().min(1).nullable(),
})

export type MessagesPage = z.output<typeof messagesPage>

/** The pure half: a participant → the identity claim that names them. */
export const participantClaim = (
  who: z.output<typeof address>,
): IdentityClaim => ({
  kind: 'person',
  keys: { email: who.email },
  ...(who.name == null ? {} : { name: who.name }),
})

export default definePlugin({
  manifest,
  jobs: {
    // D52: each participant is resolved first and the interaction names the
    // ids that came back; the message's Message-ID is the dedupe key, so a
    // page read twice is one interaction per message.
    sync: ({ cursor }) =>
      Effect.gen(function* () {
        const url = pageUrl(cursor)
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
        const raw = yield* responseJson(response, url)
        const page = yield* Effect.try({
          try: () => messagesPage.parse(raw),
          catch: () =>
            new JobPermanent({ reason: `${url} did not return a page` }),
        })

        const identity = yield* Identity
        const content = yield* Content
        let logged = 0
        for (const message of page.messages) {
          const ids: Array<EntityId> = []
          for (const who of [message.from, ...message.to]) {
            const { entityId } = yield* identity.resolve(participantClaim(who))
            if (!ids.includes(entityId)) ids.push(entityId)
          }
          const first = ids.at(0)
          if (first === undefined) continue
          yield* content.logInteraction({
            _tag: 'interaction',
            kind: 'email',
            occurredAt: message.date,
            entityIds: [first, ...ids.slice(1)],
            messageId: message.id,
            ...(message.threadId == null ? {} : { threadId: message.threadId }),
            ...(message.subject == null ? {} : { subject: message.subject }),
            ...(message.snippet == null ? {} : { body: message.snippet }),
          })
          logged++
        }
        yield* (yield* Log).info('synced', {
          cursor,
          logged,
          nextCursor: page.nextCursor,
        })
        return { nextCursor: page.nextCursor }
      }),
  },
})
