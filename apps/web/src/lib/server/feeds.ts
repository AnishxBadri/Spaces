import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

/**
 * Feeds: the Sources table's writes and both tabs' reads. Any member adds,
 * edits and removes any feed; the work is in `lib/feeds/sources`, which a
 * test drives without a request.
 */

export type {
  AddedFeed,
  FeedSource,
  FeedSpaceTag,
  Headline,
  HeadlinePage,
} from '../feeds/sources'
export type { FeedPreview } from '../feeds/preview'

const uuid = Schema.String.check(Schema.isUUID())
const address = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2000),
)
const spaceIds = Schema.Array(uuid).check(Schema.isMaxLength(50))

/**
 * Add feed: a feed URL or a site address (resolved to the feed it
 * advertises), and its spaces. Refuses with the sentence the window shows:
 * "That page has no feed", "The site answered 404", "Already a source: …".
 */
export const addFeed = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ address, spaceIds })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { addFeedProgram } = await import('../feeds/sources')
    const { effectFn } = await import('./effect')
    return effectFn(addFeedProgram)(u.id, data)
  })

/**
 * Add feed's look ahead, as the address is typed: the feed it resolves to,
 * or why it will not add. Saves nothing.
 */
export const previewFeed = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ address })))
  .handler(async ({ data }) => {
    await requireUser()
    const { previewFeedProgram } = await import('../feeds/preview')
    const { effectFn } = await import('./effect')
    return effectFn(previewFeedProgram)(data.address, new Date())
  })

/** Edit a feed's address, name or spaces; `spaceIds` replaces the tags. */
export const editFeed = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: uuid,
        address: Schema.optional(address),
        name: Schema.optional(
          Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        ),
        spaceIds: Schema.optional(spaceIds),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { editFeedProgram } = await import('../feeds/sources')
    const { effectFn } = await import('./effect')
    return effectFn(editFeedProgram)(data)
  })

/** Remove a feed with its tags and headlines. */
export const removeFeed = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    await requireUser()
    const { removeFeedProgram } = await import('../feeds/sources')
    const { effectFn } = await import('./effect')
    return effectFn(removeFeedProgram)(data.id)
  })

/** Every feed with its state, last error, spaces and counts. */
export const listFeedSources = createServerFn().handler(async () => {
  await requireUser()
  const { listFeedSourcesProgram } = await import('../feeds/sources')
  const { effectFn } = await import('./effect')
  return effectFn(listFeedSourcesProgram)()
})

/** Headlines newest first, a page at a time, narrowed to a space's subtree. */
export const listHeadlines = createServerFn()
  .validator(
    input(
      Schema.UndefinedOr(
        Schema.Struct({
          spaceId: Schema.optional(uuid),
          cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
          limit: Schema.optional(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
          ),
        }),
      ),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { listHeadlinesProgram } = await import('../feeds/sources')
    const { effectFn } = await import('./effect')
    return effectFn(listHeadlinesProgram)(data ?? {})
  })
