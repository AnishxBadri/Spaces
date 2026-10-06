import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'

import { Route as DedupeRoute } from '#/routes/_app/dedupe'
import { Route as InboxRoute } from '#/routes/_app/inbox'
import { toReview } from './to-review'

describe('the old review-queue paths', () => {
  it('answer one 301 to /review, replacing the history entry', () => {
    let thrown: unknown = null
    try {
      toReview()
    } catch (e) {
      thrown = e
    }
    if (!isRedirect(thrown)) throw new Error('toReview did not redirect')
    expect(thrown.status).toBe(301)
    expect(thrown.options).toMatchObject({
      to: '/review',
      statusCode: 301,
      replace: true,
    })
  })

  it('/inbox and /dedupe both go straight to it, so nothing chains', () => {
    expect(InboxRoute.options.beforeLoad).toBe(toReview)
    expect(DedupeRoute.options.beforeLoad).toBe(toReview)
  })
})
