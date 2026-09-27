import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import {
  createApiTokenProgram,
  listApiTokensProgram,
  revokeApiTokenProgram,
} from './store'

/**
 * The bodies of the Settings → API tokens server fns (SPA-23). Every one
 * opens with `requireUser()` and acts on the session user's own tokens only
 * — a token is a person's, never the workspace's, so there is no admin lane.
 * The server fns in `lib/server/tokens.ts` import this module inside their
 * handlers, which keeps `node:crypto` out of the client bundle.
 */

export async function listApiTokensHandler() {
  const u = await requireUser()
  return effectFn(listApiTokensProgram)(u.id)
}

/** The only response that ever carries a token's plaintext. */
export async function createApiTokenHandler(data: { name: string }) {
  const u = await requireUser()
  return effectFn(createApiTokenProgram)({ userId: u.id, name: data.name })
}

export async function revokeApiTokenHandler(data: { id: string }) {
  const u = await requireUser()
  return effectFn(revokeApiTokenProgram)({ userId: u.id, id: data.id })
}
