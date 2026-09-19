import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { count } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from '../auth'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { storeCredential } from '../vault'
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

/**
 * Signals for the getting-started card on /spaces — all derived, nothing
 * stored: each step is "done" because the real artifact exists, so the card
 * can never disagree with the data. Dismissal is client-side.
 */
export const getOnboardingProgress = createServerFn().handler(async () => {
  await requireUser()
  const { eq, sql: dsql } = await import('drizzle-orm')
  const { entity } = await import('@spaces/db/schema/entities')
  const { note, space } = await import('@spaces/db/schema/kinds')
  const { mandate } = await import('@spaces/db/schema/workspace')
  const { invite } = await import('@spaces/db/schema/auth')
  const [spaces, notes, mandates, companies, users, invites] =
    await Promise.all([
      db.select({ value: count() }).from(space),
      db.select({ value: count() }).from(note),
      db
        .select({ value: count() })
        .from(mandate)
        .where(eq(mandate.status, 'active')),
      db
        .select({ value: count() })
        .from(entity)
        .where(
          dsql`${entity.kind} = 'company' and ${entity.mergedIntoId} is null`,
        ),
      db.select({ value: count() }).from(user),
      db.select({ value: count() }).from(invite),
    ])
  return {
    mappedMarkets: spaces[0].value > 0,
    filedMemo: notes[0].value > 0,
    wroteMandate: mandates[0].value > 0,
    trackedCompany: companies[0].value > 0,
    invitedPartner: users[0].value > 1 || invites[0].value > 0,
  }
})

const aiKeyInput = z.object({
  provider: z.enum(['anthropic', 'openai', 'google', 'openrouter', 'ollama']),
  key: z.string().min(1).max(500),
  baseUrl: z.string().url().optional(),
})

export const saveAiKey = createServerFn({ method: 'POST' })
  .validator(aiKeyInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    if (u.role !== 'admin') throw new Error('Admins only')
    const { display } = await storeCredential({
      scope: 'workspace',
      provider: data.provider,
      kind: 'llm',
      secret: data.key,
      meta: data.baseUrl ? { baseUrl: data.baseUrl } : {},
      createdBy: u.id,
    })
    return { display }
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
