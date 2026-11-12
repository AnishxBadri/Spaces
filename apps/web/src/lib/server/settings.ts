import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { Effect, Schema } from 'effect'
import { auth } from '../auth'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { requireAdmin, requireUser } from './shared'
import { serverQuery } from './query'

/** A workspace logo refused before it is stored, with the reason General shows. */
class LogoRefused extends Schema.TaggedError<LogoRefused>()('LogoRefused', {
  message: Schema.String,
}) {}

const getSessionProgram = Effect.fn('getSessionProgram')(function* () {
  // A failing session lookup rejects as it always has, untouched.
  const session = yield* Effect.promise(() =>
    auth.api.getSession({ headers: getRequest().headers }),
  )
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

export const getSession = createServerFn().handler(async () =>
  Effect.runPromise(getSessionProgram()),
)

const listUsersProgram = Effect.fn('listUsersProgram')(function* () {
  return yield* serverQuery(() =>
    db.select({ id: user.id, name: user.name }).from(user),
  )
})

export const listUsers = createServerFn().handler(async () => {
  await requireUser()
  return Effect.runPromise(listUsersProgram())
})

const seedDemoProgram = Effect.fn('seedDemoProgram')(function* (
  userId: string,
) {
  const { seedDemoData } = yield* Effect.promise(() => import('../seeds/demo'))
  return yield* Effect.promise(() => seedDemoData(userId))
})

/**
 * Demo data, only ever by explicit request. Guarded on "no companies exist"
 * so it cannot land on top of real records.
 */
export const seedDemo = createServerFn({ method: 'POST' }).handler(async () => {
  const u = await requireUser()
  return Effect.runPromise(seedDemoProgram(u.id))
})

const setWorkspaceLogoProgram = Effect.fn('setWorkspaceLogoProgram')(function* (
  file: File,
  by: string,
) {
  const { LOGO_MAX_BYTES, LOGO_TOO_LARGE } = yield* Effect.promise(
    () => import('../members/workspace-logo-file'),
  )
  // Refused before the bytes are read into memory.
  if (file.size > LOGO_MAX_BYTES)
    return yield* new LogoRefused({ message: LOGO_TOO_LARGE })
  const { setLogoProgram, logoPath } = yield* Effect.promise(
    () => import('../members/workspace-logo'),
  )
  const { reclaimBlobIfOrphaned } = yield* Effect.promise(
    () => import('../documents/blob-refs'),
  )
  const bytes = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))
  const { sha, previous } = yield* setLogoProgram({ bytes, by })
  if (previous !== null)
    yield* Effect.promise(() => reclaimBlobIfOrphaned(previous))
  return { logo: logoPath(sha) }
})

/**
 * The workspace logo set or removed from General: written at once, admin
 * only. The bytes it replaced are reclaimed once no row names them.
 */
export const setWorkspaceLogo = createServerFn({ method: 'POST' })
  .validator((data: FormData) => {
    const file = data.get('file')
    if (!(file instanceof File))
      throw new LogoRefused({ message: 'Choose an image' })
    return { file }
  })
  .handler(async ({ data }) => {
    const u = await requireAdmin()
    return Effect.runPromise(setWorkspaceLogoProgram(data.file, u.id))
  })

const clearWorkspaceLogoProgram = Effect.fn('clearWorkspaceLogoProgram')(
  function* () {
    const { clearLogoProgram } = yield* Effect.promise(
      () => import('../members/workspace-logo'),
    )
    const { reclaimBlobIfOrphaned } = yield* Effect.promise(
      () => import('../documents/blob-refs'),
    )
    const { previous } = yield* clearLogoProgram()
    if (previous !== null)
      yield* Effect.promise(() => reclaimBlobIfOrphaned(previous))
    return { logo: null }
  },
)

export const clearWorkspaceLogo = createServerFn({ method: 'POST' }).handler(
  async () => {
    await requireAdmin()
    return Effect.runPromise(clearWorkspaceLogoProgram())
  },
)
