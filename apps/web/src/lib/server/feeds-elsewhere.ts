import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

/**
 * Feeds outside the Feeds page: Today's one line. A space's headlines and
 * feeds ride on its watching read. The work is in `lib/feeds/elsewhere`.
 */

export type {
  SpaceFeeds,
  SpaceHeadline,
  TodayHeadlines,
} from '../feeds/elsewhere'
export type { SpaceMoving } from '../spaces/watching'

const instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, {
    message: 'Expected an ISO instant',
  }),
)

/**
 * How many headlines were first seen in the reader's day, `[from, to)` from
 * its clock, and from which feeds.
 */
export const getTodayHeadlines = createServerFn()
  .validator(input(Schema.Struct({ from: instant, to: instant })))
  .handler(async ({ data }) => {
    await requireUser()
    const { todayHeadlinesProgram } = await import('../feeds/elsewhere')
    const { effectFn } = await import('./effect')
    return effectFn(todayHeadlinesProgram)(
      new Date(data.from),
      new Date(data.to),
    )
  })
