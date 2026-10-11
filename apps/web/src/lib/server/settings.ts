import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { count } from 'drizzle-orm'
import { auth } from '../auth'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { requireAdmin, requireUser } from './shared'

export const getSession = createServerFn().handler(async () => {
  const session = await auth.api.getSession({
    headers: getRequest().headers,
  })
  if (!session) return null
  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      role: session.user.role,
    },
  }
})

/**
 * True until the first admin exists — drives the /setup redirect. Asking
 * while setup is needed (re)prints the one-time token to the server logs,
 * so the operator who just opened /setup finds it waiting in the terminal.
 */
export const getSetupState = createServerFn().handler(async () => {
  const [{ value }] = await db.select({ value: count() }).from(user)
  const needsSetup = value === 0
  if (needsSetup) {
    const { printSetupToken } = await import('../setup-token')
    printSetupToken()
  }
  return { needsSetup }
})

export const listUsers = createServerFn().handler(async () => {
  await requireUser()
  return db.select({ id: user.id, name: user.name }).from(user)
})

/**
 * Demo data, only ever by explicit request. Guarded on "no companies exist"
 * so it cannot land on top of real records.
 */
export const seedDemo = createServerFn({ method: 'POST' }).handler(async () => {
  const u = await requireUser()
  const { seedDemoData } = await import('../seeds/demo')
  return seedDemoData(u.id)
})

/**
 * The workspace logo set or removed from General: written at once, admin
 * only. The bytes it replaced are reclaimed once no row names them. (D81)
 */
export const setWorkspaceLogo = createServerFn({ method: 'POST' })
  .validator((data: FormData) => {
    const file = data.get('file')
    if (!(file instanceof File)) throw new Error('Choose an image')
    return { file }
  })
  .handler(async ({ data }) => {
    const u = await requireAdmin()
    const { LOGO_MAX_BYTES, LOGO_TOO_LARGE } =
      await import('../members/workspace-logo-file')
    // Refused before the bytes are read into memory.
    if (data.file.size > LOGO_MAX_BYTES) throw new Error(LOGO_TOO_LARGE)
    const { setLogoProgram, logoPath } =
      await import('../members/workspace-logo')
    const { reclaimBlobIfOrphaned } = await import('../documents/blob-refs')
    const { effectFn } = await import('./effect')
    const { sha, previous } = await effectFn(setLogoProgram)({
      bytes: new Uint8Array(await data.file.arrayBuffer()),
      by: u.id,
    })
    if (previous !== null) await reclaimBlobIfOrphaned(previous)
    return { logo: logoPath(sha) }
  })

export const clearWorkspaceLogo = createServerFn({ method: 'POST' }).handler(
  async () => {
    await requireAdmin()
    const { clearLogoProgram } = await import('../members/workspace-logo')
    const { reclaimBlobIfOrphaned } = await import('../documents/blob-refs')
    const { effectFn } = await import('./effect')
    const { previous } = await effectFn(clearLogoProgram)()
    if (previous !== null) await reclaimBlobIfOrphaned(previous)
    return { logo: null }
  },
)
