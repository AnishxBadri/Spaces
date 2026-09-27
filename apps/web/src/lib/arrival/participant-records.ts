import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { mailbox } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { registrableDomain } from '@spaces/core/entities/normalize'
import { resolveEntity } from '#/lib/entities/resolve'
import type { ResolveResult, ResolveSource } from '#/lib/entities/resolve'
import { isFreeEmailDomain } from './free-email-domains'
import type { ArrivalMessage } from './message'
import { decideParticipants } from './participants'
import type { ParticipantDecision } from './participants'

/**
 * The write half of `participants.ts` (SPA-86): every `create` decision goes
 * through `resolveEntity`, the single entry gate, with the mailbox's
 * integration as its source — so a new record, its identity aliases and its
 * birth events all carry `source_class = 'integration'` and the one
 * `core.mailbox` row as `source_ref`, and the inbox card names the channel.
 * A key another kind of record already holds is the gate's collision door
 * (a `duplicate_candidate`), not this module's business.
 *
 * Runs before `file.ts` opens its transaction, because `resolveEntity`
 * commits its own; and it runs for a duplicate too, which is what makes a
 * re-poll all attaches rather than a no-op that proves nothing. A record
 * created here for a message whose interaction then fails to write is not
 * an orphan: it is a record the next poll attaches to.
 *
 * Who "we" are is read, not configured: the workspace members' addresses,
 * and as own domains the work domains among those addresses plus the
 * forwarding mailbox's own — the workspace row carries no domain, and a
 * member on Gmail must not make every Gmail participant internal.
 */

export class ParticipantRecordsFailed extends Schema.TaggedError<ParticipantRecordsFailed>()(
  'ParticipantRecordsFailed',
  { cause: Schema.Defect() },
) {}

export type WorkspaceIdentity = {
  ownDomains: Array<string>
  memberEmails: Array<string>
}

export type ParticipantRecords = {
  /** People and companies the thread's participants resolved to. */
  entityIds: Array<string>
  created: number
  attached: number
  decisions: Array<ParticipantDecision>
}

export type ParticipantContext = {
  /** The core mailbox integration — `source_ref` on every record made. */
  integrationId: string
  /** The workspace user the arrival is filed under. */
  authorId: string
}

/** The members, and the domains that are ours. */
export async function workspaceIdentity(
  integrationId: string,
): Promise<WorkspaceIdentity> {
  const members = await db.select({ email: user.email }).from(user)
  const boxes = await db
    .select({ address: mailbox.address })
    .from(mailbox)
    .where(eq(mailbox.integrationId, integrationId))
  const hosts = [
    ...members.map((m) => m.email),
    ...boxes.map((b) => b.address),
  ].map((a) => a.slice(a.lastIndexOf('@') + 1))
  const ownDomains = [
    ...new Set(
      hosts
        .filter((h) => !isFreeEmailDomain(h))
        .map((h) => registrableDomain(h))
        .filter((d): d is string => d !== null),
    ),
  ]
  return { ownDomains, memberEmails: members.map((m) => m.email) }
}

export const participantRecordsProgram = Effect.fn('participantRecords')(
  function* (
    message: ArrivalMessage,
    ctx: ParticipantContext,
  ): Effect.fn.Return<ParticipantRecords, ParticipantRecordsFailed> {
    const run = <T>(f: () => Promise<T>) =>
      Effect.tryPromise({
        try: f,
        catch: (cause) => new ParticipantRecordsFailed({ cause }),
      })
    const identity = yield* run(() => workspaceIdentity(ctx.integrationId))
    const decisions = decideParticipants({
      from: message.from,
      to: message.to,
      cc: message.cc,
      ...identity,
    })

    const source: ResolveSource = {
      class: 'integration',
      ref: ctx.integrationId,
    }
    const results: Array<ResolveResult> = []
    for (const d of decisions) {
      if (d.action !== 'create') continue
      const { company, person } = d
      if (company !== null) {
        results.push(
          yield* run(() =>
            resolveEntity({
              kind: 'company',
              name: company.name,
              keys: { domain: company.domain },
              source,
              createdBy: ctx.authorId,
            }),
          ),
        )
      }
      if (person !== null) {
        results.push(
          yield* run(() =>
            resolveEntity({
              kind: 'person',
              ...(person.name === null ? {} : { name: person.name }),
              keys: { email: person.email },
              source,
              createdBy: ctx.authorId,
            }),
          ),
        )
      }
    }
    return {
      entityIds: [...new Set(results.map((r) => r.entityId))],
      created: results.filter((r) => r.action === 'created').length,
      attached: results.filter((r) => r.action === 'attached').length,
      decisions,
    }
  },
)
