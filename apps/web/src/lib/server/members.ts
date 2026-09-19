import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, count, eq, gt, isNull, ne } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { invite, session, user } from '#/db/schema/auth'
import { workspace } from '#/db/schema/workspace'
import { requireAdmin, requireUser } from './shared'

// ---------- workspace singleton ----------

export const getWorkspace = createServerFn().handler(async () => {
  await requireUser()
  const row = (await db.select().from(workspace).where(eq(workspace.id, 1))).at(
    0,
  )
  if (!row) return null
  return { name: row.name }
})

export const saveWorkspace = createServerFn({ method: 'POST' })
  .validator(z.object({ name: z.string().trim().min(1).max(120) }))
  .handler(async ({ data }) => {
    await requireAdmin()
    await db
      .insert(workspace)
      .values({ id: 1, name: data.name })
      .onConflictDoUpdate({
        target: workspace.id,
        set: { name: data.name, updatedAt: new Date() },
      })
    return { ok: true }
  })

// ---------- members ----------

export const listMembers = createServerFn().handler(async () => {
  await requireUser()
  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(asc(user.createdAt))
})

/**
 * Role changes guard the last admin: a workspace where nobody can manage
 * users or settings is bricked, and the operator who does it to themselves
 * has no recovery path short of SQL.
 */
export const setMemberRole = createServerFn({ method: 'POST' })
  .validator(
    z.object({ userId: z.string(), role: z.enum(['admin', 'member']) }),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    if (data.role === 'member') {
      // Banned admins don't count — they cannot log in, so a workspace
      // whose only other "admin" is banned is functionally admin-less.
      const [{ value: otherAdmins }] = await db
        .select({ value: count() })
        .from(user)
        .where(
          and(
            eq(user.role, 'admin'),
            eq(user.banned, false),
            ne(user.id, data.userId),
          ),
        )
      if (otherAdmins === 0) {
        throw new Error('Cannot demote the only active admin.')
      }
    }
    await db
      .update(user)
      .set({ role: data.role, updatedAt: new Date() })
      .where(eq(user.id, data.userId))
    return { ok: true }
  })

/** Ban blocks login (Better Auth admin plugin checks the flag) and kills live sessions. */
export const setMemberBanned = createServerFn({ method: 'POST' })
  .validator(z.object({ userId: z.string(), banned: z.boolean() }))
  .handler(async ({ data }) => {
    const admin = await requireAdmin()
    if (data.userId === admin.id) {
      throw new Error('You cannot ban yourself.')
    }
    if (data.banned) {
      // Same lockout as demotion: banning the last active admin bricks
      // the workspace just as surely.
      const target = (
        await db
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, data.userId))
      ).at(0)
      if (target?.role === 'admin') {
        const [{ value: otherAdmins }] = await db
          .select({ value: count() })
          .from(user)
          .where(
            and(
              eq(user.role, 'admin'),
              eq(user.banned, false),
              ne(user.id, data.userId),
            ),
          )
        if (otherAdmins === 0) {
          throw new Error('Cannot ban the only active admin.')
        }
      }
    }
    await db
      .update(user)
      .set({ banned: data.banned, updatedAt: new Date() })
      .where(eq(user.id, data.userId))
    if (data.banned) {
      await db.delete(session).where(eq(session.userId, data.userId))
    }
    return { ok: true }
  })

/** "Sign out everywhere" — sessions are DB rows, so revocation is a delete. */
export const revokeMemberSessions = createServerFn({ method: 'POST' })
  .validator(z.object({ userId: z.string() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    if (u.id !== data.userId && u.role !== 'admin') {
      throw new Error('Admins only')
    }
    await db.delete(session).where(eq(session.userId, data.userId))
    return { ok: true }
  })

// ---------- invites ----------

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function inviteUrl(token: string): string {
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  return `${base.replace(/\/$/, '')}/join?token=${token}`
}

/**
 * The raw token exists exactly once, in this response — only its hash is
 * stored. Shown as a copyable link so invites work without SMTP.
 */
export const createInvite = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      email: z.string().email().optional(),
      role: z.enum(['admin', 'member']).default('member'),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireAdmin()
    const token = randomBytes(24).toString('base64url')
    await db.insert(invite).values({
      id: randomUUID(),
      tokenHash: createHash('sha256').update(token).digest('hex'),
      email: data.email?.toLowerCase() ?? null,
      role: data.role,
      invitedBy: u.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    return { url: inviteUrl(token) }
  })

export const listInvites = createServerFn().handler(async () => {
  await requireAdmin()
  return db
    .select({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    })
    .from(invite)
    .where(and(isNull(invite.usedAt), gt(invite.expiresAt, new Date())))
    .orderBy(asc(invite.createdAt))
})

export const revokeInvite = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireAdmin()
    await db.delete(invite).where(eq(invite.id, data.id))
    return { ok: true }
  })

/**
 * Public — the /join page runs before any session exists. Returns only what
 * the joining person needs to see; never the hash, never who else exists.
 */
export const getInvitePreview = createServerFn()
  .validator(z.object({ token: z.string().min(1).max(200) }))
  .handler(async ({ data }) => {
    const hash = createHash('sha256').update(data.token.trim()).digest('hex')
    const inv = (
      await db
        .select({ email: invite.email, role: invite.role })
        .from(invite)
        .where(
          and(
            eq(invite.tokenHash, hash),
            isNull(invite.usedAt),
            gt(invite.expiresAt, new Date()),
          ),
        )
    ).at(0)
    if (!inv) return { valid: false as const }
    const ws = (
      await db
        .select({ name: workspace.name })
        .from(workspace)
        .where(eq(workspace.id, 1))
    ).at(0)
    return {
      valid: true as const,
      email: inv.email,
      role: inv.role,
      workspaceName: ws?.name ?? null,
    }
  })
