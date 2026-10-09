import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { count } from 'drizzle-orm'
import { auth } from '../auth'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { requireUser } from './shared'

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

export const canSeedDemoData = createServerFn().handler(async () => {
  await requireUser()
  const { canSeedDemo } = await import('../seeds/demo')
  return { canSeed: await canSeedDemo() }
})
