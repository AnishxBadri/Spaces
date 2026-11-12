import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { and, asc, count, eq, gt, isNull, ne } from 'drizzle-orm'
import { db } from '@spaces/db'
import { invite, user } from '@spaces/db/schema/auth'
import { workspace } from '@spaces/db/schema/workspace'
import { requireAdmin, requireUser } from './shared'
import { input } from './input'
import { serverQuery } from './query'

const role = Schema.Literals(['admin', 'member'])

const inviteToken = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
)

class LastAdmin extends Schema.TaggedError<LastAdmin>()('LastAdmin', {
  message: Schema.String,
}) {}

// ---------- workspace singleton ----------

const getWorkspaceProgram = Effect.fn('getWorkspaceProgram')(function* () {
  const row = (yield* serverQuery(() =>
    db.select().from(workspace).where(eq(workspace.id, 1)),
  )).at(0)
  if (!row) return null
  const { logoShaOf, logoPath } = yield* Effect.promise(
    () => import('../members/workspace-logo'),
  )
  const sha = logoShaOf(row.settings)
  return { name: row.name, logo: sha === null ? null : logoPath(sha) }
})

export const getWorkspace = createServerFn().handler(async () => {
  await requireUser()
  return Effect.runPromise(getWorkspaceProgram())
})

const saveWorkspaceProgram = Effect.fn('saveWorkspaceProgram')(function* (
  name: string,
) {
  yield* serverQuery(() =>
    db
      .insert(workspace)
      .values({ id: 1, name })
      .onConflictDoUpdate({
        target: workspace.id,
        set: { name, updatedAt: new Date() },
      }),
  )
  return { ok: true }
})

export const saveWorkspace = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    return Effect.runPromise(saveWorkspaceProgram(data.name))
  })

// ---------- members ----------

const listMembersProgram = Effect.fn('listMembersProgram')(function* () {
  return yield* serverQuery(() =>
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        banned: user.banned,
        createdAt: user.createdAt,
      })
      .from(user)
      .orderBy(asc(user.createdAt)),
  )
})

export const listMembers = createServerFn().handler(async () => {
  await requireUser()
  return Effect.runPromise(listMembersProgram())
})

const setMemberRoleProgram = Effect.fn('setMemberRoleProgram')(function* (
  userId: string,
  to: 'admin' | 'member',
) {
  if (to === 'member') {
    // Banned admins don't count — they cannot log in, so a workspace
    // whose only other "admin" is banned is functionally admin-less.
    const [{ value: otherAdmins }] = yield* serverQuery(() =>
      db
        .select({ value: count() })
        .from(user)
        .where(
          and(
            eq(user.role, 'admin'),
            eq(user.banned, false),
            ne(user.id, userId),
          ),
        ),
    )
    if (otherAdmins === 0) {
      return yield* new LastAdmin({
        message: 'Cannot demote the only active admin.',
      })
    }
  }
  yield* serverQuery(() =>
    db
      .update(user)
      .set({ role: to, updatedAt: new Date() })
      .where(eq(user.id, userId)),
  )
  return { ok: true }
})

/**
 * Role changes guard the last admin: a workspace where nobody can manage
 * users or settings is bricked, and the operator who does it to themselves
 * has no recovery path short of SQL.
 */
export const setMemberRole = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ userId: Schema.String, role })))
  .handler(async ({ data }) => {
    await requireAdmin()
    return Effect.runPromise(setMemberRoleProgram(data.userId, data.role))
  })

/** Ban blocks login (Better Auth admin plugin checks the flag) and kills live sessions. */
export const setMemberBanned = createServerFn({ method: 'POST' })
  .validator(
    input(Schema.Struct({ userId: Schema.String, banned: Schema.Boolean })),
  )
  .handler(async ({ data }) => {
    // The program lives outside the server-fn modules so a test can drive
    // the real suspension (a suspended member's MCP token stops answering).
    const { setMemberBannedProgram } = await import('#/lib/members/suspend')
    return Effect.runPromise(setMemberBannedProgram(data))
  })

// ---------- invites ----------

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function inviteUrl(token: string): string {
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  return `${base.replace(/\/$/, '')}/join?token=${token}`
}

// The address pattern the invite form has always been held to.
const email = Schema.String.check(
  Schema.isPattern(
    /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/,
    { message: 'Expected an email address' },
  ),
)

const createInviteProgram = Effect.fn('createInviteProgram')(function* (
  invitedBy: string,
  data: { email?: string | undefined; role: 'admin' | 'member' },
) {
  const raw = randomBytes(24).toString('base64url')
  yield* serverQuery(() =>
    db.insert(invite).values({
      id: randomUUID(),
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      email: data.email?.toLowerCase() ?? null,
      role: data.role,
      invitedBy,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    }),
  )
  return { url: inviteUrl(raw) }
})

/**
 * The raw token exists exactly once, in this response — only its hash is
 * stored. Shown as a copyable link so invites work without SMTP.
 */
export const createInvite = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        email: Schema.optional(email),
        role: role.pipe(
          Schema.withDecodingDefault(
            Effect.succeed<'admin' | 'member'>('member'),
          ),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireAdmin()
    return Effect.runPromise(createInviteProgram(u.id, data))
  })

const listInvitesProgram = Effect.fn('listInvitesProgram')(function* () {
  return yield* serverQuery(() =>
    db
      .select({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      })
      .from(invite)
      .where(and(isNull(invite.usedAt), gt(invite.expiresAt, new Date())))
      .orderBy(asc(invite.createdAt)),
  )
})

export const listInvites = createServerFn().handler(async () => {
  await requireAdmin()
  return Effect.runPromise(listInvitesProgram())
})

const revokeInviteProgram = Effect.fn('revokeInviteProgram')(function* (
  id: string,
) {
  yield* serverQuery(() => db.delete(invite).where(eq(invite.id, id)))
  return { ok: true }
})

export const revokeInvite = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: Schema.String.check(Schema.isUUID()) })))
  .handler(async ({ data }) => {
    await requireAdmin()
    return Effect.runPromise(revokeInviteProgram(data.id))
  })

const invitePreviewProgram = Effect.fn('invitePreviewProgram')(function* (
  raw: string,
) {
  const hash = createHash('sha256').update(raw.trim()).digest('hex')
  const inv = (yield* serverQuery(() =>
    db
      .select({ email: invite.email, role: invite.role })
      .from(invite)
      .where(
        and(
          eq(invite.tokenHash, hash),
          isNull(invite.usedAt),
          gt(invite.expiresAt, new Date()),
        ),
      ),
  )).at(0)
  if (!inv) return { valid: false as const }
  const ws = (yield* serverQuery(() =>
    db
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, 1)),
  )).at(0)
  return {
    valid: true as const,
    email: inv.email,
    role: inv.role,
    workspaceName: ws?.name ?? null,
  }
})

/**
 * Public — the /join page runs before any session exists. Returns only what
 * the joining person needs to see; never the hash, never who else exists.
 */
export const getInvitePreview = createServerFn()
  .validator(input(Schema.Struct({ token: inviteToken })))
  .handler(async ({ data }) =>
    Effect.runPromise(invitePreviewProgram(data.token)),
  )

// ---------- password reset links ----------

/** Admin-issued: the response is the one place the link appears. */
export const createResetLink = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({ userId: Schema.String.check(Schema.isMinLength(1)) }),
    ),
  )
  .handler(async ({ data }) => {
    const admin = await requireAdmin()
    const { createResetLinkProgram } = await import('../members/reset-link')
    return Effect.runPromise(
      createResetLinkProgram({ adminId: admin.id, userId: data.userId }),
    )
  })

/** Public — the /reset page runs before any session exists. */
export const getResetPreview = createServerFn()
  .validator(input(Schema.Struct({ token: inviteToken })))
  .handler(async ({ data }) => {
    const { resetPreviewProgram } = await import('../members/reset-link')
    return Effect.runPromise(resetPreviewProgram(data.token))
  })
