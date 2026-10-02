import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { API_PREFIX } from './versions'

/**
 * `/api/v1` shadows nothing (SPA-45). The raw routes stay raw and stay where
 * they are: an HMAC over an exact raw body is not a procedure
 * (docs/spec-plugin-sdk.md §11), and a path moved under the versioned
 * namespace would become an external contract. Read from the committed route
 * tree, so a route file added under `routes/api/v1/` fails here by name.
 */

const routeTree = readFileSync(
  new URL('../../routeTree.gen.ts', import.meta.url),
  'utf8',
)

/** Every `/api` full path the router knows, from `FileRoutesByFullPath`. */
const apiRoutes = (): Array<string> => {
  const block = /export interface FileRoutesByFullPath \{([^}]*)\}/.exec(
    routeTree,
  )?.[1]
  expect(block, 'FileRoutesByFullPath in routeTree.gen.ts').toBeDefined()
  return [...(block ?? '').matchAll(/'(\/api(?:\/[^']*)?)':/g)].map(
    ([, path]) => path,
  )
}

const underPrefix = (path: string) =>
  path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)

/** Raw by design, and mounted today. The job-status stream is SSE (D64). */
const RAW = [
  '/api/auth/$',
  '/api/blob/$key',
  '/api/health',
  '/api/job-status/$entityId',
  '/api/mcp',
]

/** Raw by design, mounted by the ingress slice (sdk-23) when it lands. */
const RAW_TO_COME = ['/api/webhooks/$provider']

describe(`the ${API_PREFIX} namespace`, () => {
  it('is one splat route and nothing else', () => {
    expect(apiRoutes().filter(underPrefix)).toEqual([`${API_PREFIX}/$`])
  })

  it('leaves every raw route outside it, where it already is', () => {
    const routes = apiRoutes()
    for (const path of RAW) {
      expect(routes, path).toContain(path)
      expect(underPrefix(path), path).toBe(false)
    }
    for (const path of RAW_TO_COME) {
      expect(underPrefix(path), path).toBe(false)
    }
  })

  it('every other /api route is raw', () => {
    const others = apiRoutes().filter((path) => !underPrefix(path))
    for (const path of others) {
      expect(
        [...RAW, ...RAW_TO_COME],
        `${path} is a new /api route: list it here if it is raw by design, or make it a procedure in api.ts`,
      ).toContain(path)
    }
  })
})
