import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { API_SCOPES } from '../tokens/scopes'
import { input } from './input'

const uuid = Schema.String.check(Schema.isUUID())

/**
 * Settings → API tokens: the MCP server's per-user credentials. The bodies
 * are imported inside each handler, so the token store (and `node:crypto`) never reach the client
 * bundle — this module is re-exported by the client-imported barrel.
 */

export const listApiTokens = createServerFn().handler(async () => {
  const { listApiTokensHandler } = await import('../tokens/handlers')
  return listApiTokensHandler()
})

/** Mints a token; the response is the one place its plaintext appears. */
export const createApiToken = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        name: Schema.String.check(Schema.isMaxLength(200)),
        // What the token may do at /api/v1. MCP ignores it.
        scopes: Schema.mutable(Schema.Array(Schema.Literals(API_SCOPES))).check(
          Schema.isMaxLength(API_SCOPES.length),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const { createApiTokenHandler } = await import('../tokens/handlers')
    return createApiTokenHandler(data)
  })

export const revokeApiToken = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const { revokeApiTokenHandler } = await import('../tokens/handlers')
    return revokeApiTokenHandler(data)
  })
