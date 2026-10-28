import { Effect, Schema } from 'effect'
import { and, asc, count, eq, isNull, ne } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  credential,
  entity,
  integration,
  mailbox,
  user,
  workspace,
} from '@spaces/db/schema'
import { manifestSchema } from '@spaces/sdk'
import type { SetupState } from '#/lib/setup/whats-set-up'

/**
 * The first-run reads: whether the workspace holds a company yet, who
 * a member asks, and What's set up. Each is read live;
 * nothing about setup is stored.
 */

export class SetupReadFailed extends Schema.TaggedError<SetupReadFailed>()(
  'SetupReadFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SetupReadFailed({ cause }),
  })

/** Live companies — a merged-away row is not one. */
export const companyCountProgram = Effect.fn('companyCountProgram')(
  function* (): Effect.fn.Return<number, SetupReadFailed> {
    const rows = yield* query(() =>
      db
        .select({ value: count() })
        .from(entity)
        .where(and(eq(entity.kind, 'company'), isNull(entity.mergedIntoId))),
    )
    return rows.at(0)?.value ?? 0
  },
)

/**
 * Whether the first admin is still to be made, and once made, the workspace's
 * name — what login prints to someone sent there from a closed /setup.
 */
export type SetupGate = {
  readonly needsSetup: boolean
  readonly workspaceName: string | null
}

export const setupGateProgram = Effect.fn('setupGateProgram')(
  function* (): Effect.fn.Return<SetupGate, SetupReadFailed> {
    const users = yield* query(() => db.select({ value: count() }).from(user))
    if ((users.at(0)?.value ?? 0) === 0)
      return { needsSetup: true, workspaceName: null }
    const rows = yield* query(() =>
      db
        .select({ name: workspace.name })
        .from(workspace)
        .where(eq(workspace.id, 1)),
    )
    return { needsSetup: false, workspaceName: rows.at(0)?.name ?? null }
  },
)

/** Who reads a setup prompt: an admin gets the link, a member the names. */
export type SetupAudience = {
  readonly isAdmin: boolean
  readonly admins: ReadonlyArray<string>
}

export const setupAudienceProgram = Effect.fn('setupAudienceProgram')(
  function* (role: string): Effect.fn.Return<SetupAudience, SetupReadFailed> {
    // Banned admins cannot log in, so a member is never sent to one.
    const rows = yield* query(() =>
      db
        .select({ name: user.name })
        .from(user)
        .where(and(eq(user.role, 'admin'), eq(user.banned, false)))
        .orderBy(asc(user.createdAt)),
    )
    return { isAdmin: role === 'admin', admins: rows.map((r) => r.name) }
  },
)

/**
 * What's set up, each item from where it lives:
 * - AI model: an active `llm` credential in the vault (Ollama is one too).
 * - Team: more than one user.
 * - Enrichment: a runnable plugin with the `enrichment` role. The Website
 *   source needs nothing, so it never counts.
 * - Email forwarding: a `mailbox` row.
 * - Google: an `account_connection` with provider google, not revoked.
 * - Granola, Exa: an enabled `integration` row with that capability id.
 */
export const whatsSetUpProgram = Effect.fn('whatsSetUpProgram')(
  function* (): Effect.fn.Return<SetupState, SetupReadFailed> {
    const [llm, users, mailboxes, google, rows] = yield* Effect.all(
      [
        query(() =>
          db
            .select({ value: count() })
            .from(credential)
            .where(
              and(eq(credential.kind, 'llm'), eq(credential.status, 'active')),
            ),
        ),
        query(() => db.select({ value: count() }).from(user)),
        query(() => db.select({ value: count() }).from(mailbox)),
        query(() =>
          db
            .select({ value: count() })
            .from(accountConnection)
            .where(
              and(
                eq(accountConnection.provider, 'google'),
                ne(accountConnection.status, 'revoked'),
              ),
            ),
        ),
        query(() =>
          db
            .select({
              capabilityId: integration.capabilityId,
              enabled: integration.enabled,
              status: integration.status,
              manifest: integration.manifest,
            })
            .from(integration),
        ),
      ],
      { concurrency: 'unbounded' },
    )
    const n = (r: ReadonlyArray<{ value: number }>) => r.at(0)?.value ?? 0
    const enabled = (id: string) =>
      rows.some((r) => r.capabilityId === id && r.enabled)
    const enrichmentPlugin = rows.some(
      (r) =>
        r.enabled &&
        r.status === 'enabled' &&
        (manifestSchema.safeParse(r.manifest).data?.roles ?? []).includes(
          'enrichment',
        ),
    )
    return {
      model: n(llm) > 0,
      team: n(users) > 1,
      enrichment: enrichmentPlugin,
      forwarding: n(mailboxes) > 0,
      google: n(google) > 0,
      granola: enabled('granola'),
      exa: enabled('exa'),
    }
  },
)
