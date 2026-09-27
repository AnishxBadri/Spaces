import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { API_SCOPES } from '../tokens/scopes'

/**
 * Settings → API tokens (SPA-23): the MCP server's per-user credentials.
 * The bodies live in `lib/tokens/handlers.ts` and are imported inside each
 * handler, so the token store (and `node:crypto`) never reach the client
 * bundle — this module is re-exported by the client-imported barrel.
 */

export const listApiTokens = createServerFn().handler(async () => {
  const { listApiTokensHandler } = await import('../tokens/handlers')
  return listApiTokensHandler()
})

/** Mints a token; the response is the one place its plaintext appears. */
export const createApiToken = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      name: z.string().max(200),
      // What the token may do at /api/v1 (SPA-48). MCP ignores it.
      scopes: z.array(z.enum(API_SCOPES)).max(API_SCOPES.length),
    }),
  )
  .handler(async ({ data }) => {
    const { createApiTokenHandler } = await import('../tokens/handlers')
    return createApiTokenHandler(data)
  })

export const revokeApiToken = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { revokeApiTokenHandler } = await import('../tokens/handlers')
    return revokeApiTokenHandler(data)
  })
