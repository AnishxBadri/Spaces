import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'

import { Route as DocumentsRoute } from '#/routes/_app/documents'
import { filesSearch, toFiles } from './to-files'

const thrownBy = (run: () => unknown) => {
  try {
    run()
  } catch (e) {
    return e
  }
  throw new Error('did not throw')
}

describe('the old /documents path', () => {
  it('answers one 301 to /files, replacing the history entry', () => {
    const thrown = thrownBy(() => toFiles({ search: { filed: 'all' } }))
    if (!isRedirect(thrown)) throw new Error('toFiles did not redirect')
    expect(thrown.status).toBe(301)
    expect(thrown.options).toMatchObject({
      to: '/files',
      statusCode: 301,
      replace: true,
    })
  })

  it('carries the query whole: ?filed=unfiled lands on the same list', () => {
    const search = filesSearch.parse({ filed: 'unfiled', view: 'v1' })
    const thrown = thrownBy(() => toFiles({ search }))
    if (!isRedirect(thrown)) throw new Error('toFiles did not redirect')
    expect(thrown.options.search).toEqual({ filed: 'unfiled', view: 'v1' })
  })

  it('is the route’s beforeLoad, reading the Files page’s own search', () => {
    expect(DocumentsRoute.options.beforeLoad).toBe(toFiles)
    expect(DocumentsRoute.options.validateSearch).toBe(filesSearch)
  })
})
