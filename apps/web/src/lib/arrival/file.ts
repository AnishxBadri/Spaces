import { Effect, Schema } from 'effect'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  normalizeDomain,
  normalizeEmail,
} from '@spaces/core/entities/normalize'
import { db } from '@spaces/db'
import {
  entity,
  entityAlias,
  interaction,
  interactionEntity,
} from '@spaces/db/schema'
import { writeIntegrationInteraction } from '@spaces/core/writes/interactions/write'
import type { Address } from './forwarded'
import type { ArrivalMessage } from './message'
import { participantRecordsProgram } from './participant-records'
import { NO_ATTACHMENTS, fileAttachmentsProgram } from './attachment-filing'
import type { AttachmentOutcome } from './attachment-filing'

/**
 * One arrival → one interaction, its body note and its edges (SPA-56; D30,
 * D49). The write half of the poll, and the only place this lane touches the
 * graph.
 *
 * **The dedupe is the index.** `interaction_message_id_unique` is what makes a
 * re-poll, a second forward of one message and a partner forwarding the same
 * thread all land on one row: the insert is `on conflict (message_id) do
 * nothing`, and an empty `returning` is the duplicate. Nothing checks first —
 * a pre-check would race a concurrent poll, and the index cannot.
 *
 * **Everything in one transaction**, the interaction first: a duplicate
 * leaves no orphan body note behind, and a failed edge insert leaves no
 * bodyless interaction that the next poll would then skip as a duplicate.
 *
 * **The row, its body and its edges are core's writer** (SPA-200, sdk-7b):
 * `writeIntegrationInteraction` (`@spaces/core/writes/interactions/write`)
 * is the integration interaction lane, shared with the plugin SDK's
 * `Content.logInteraction`. This module keeps what is the mailbox's own —
 * who the participants are, which thread edges a reply inherits, and where
 * the attachments file — and hands the writer the rest.
 *
 * **Participants become records first, then are matched** (SPA-86,
 * arrival-2). Before the transaction, `participantRecordsProgram` decides
 * create / attach / ignore per address (`participants.ts`, pure) and sends
 * every survivor through `resolveEntity` — the one entry gate, which commits
 * on its own and is why this step cannot sit inside the transaction. The
 * match below then runs as before over aliases that now exist: an address
 * resolves through `entity_alias` — the person whose `email` alias it is, the
 * company whose `domain` alias its domain is — which is also how a member or
 * an own-domain address, never created, is still named when its record
 * exists. The records the gate returned are edged too, so a company that
 * lost its domain claim to another kind of record (a `duplicate_candidate`)
 * is still on the thread. Nothing here inserts into `entity` or
 * `entity_alias` itself (`one-door.test.ts`).
 *
 * **Edges go to people and companies only** (D49). A deal's threads are
 * derived — every thread on its company or one of its contacts — so nothing
 * here ever edges a deal, not even by inheritance.
 *
 * **A reply inherits its thread's edges.** Every person and company already
 * edged to an interaction on the same `thread_id` is edged to this one too,
 * so next week's reply is on the same records without re-matching — even
 * when its only participant in common with the thread root is the root.
 *
 * **The body is a note, born shared** (D30, amended by D49). Forwarding is
 * the consent, so a forwarded body is `visibility: 'shared'` from birth; the
 * private-until-attached default is the synced mailbox's (arrival-10), not
 * this lane's. The note is claimed by `interaction.note_id` and filed
 * against nothing: it reaches a record through the interaction's edges on
 * the timeline, not through `link(tagged_in)`, which would put every mail in
 * every participant's Notes section.
 *
 * **Attachments follow the interaction, and only a written one** (SPA-115,
 * `attachment-filing.ts`). The filing company is chosen inside the
 * transaction from the edges it just wrote (`chooseFilingCompany`); the
 * parts go through the documents intake after it commits, because intake
 * commits on its own. A duplicate files nothing: the Message-ID already
 * brought its attachments in, and re-reading a renumbered folder must not
 * mint a second unfiled copy of every deck in it — §3.4's dedupe is a rule
 * about a target, and an unfiled document has none.
 */

export class ArrivalWriteFailed extends Schema.TaggedError<ArrivalWriteFailed>()(
  'ArrivalWriteFailed',
  { cause: Schema.Defect() },
) {}

export type FileContext = {
  /** The core mailbox integration — `source_ref` on every row written. */
  integrationId: string
  /** The workspace user the body note is authored by. */
  authorId: string
}

export type Filed =
  | {
      kind: 'written'
      interactionId: string
      noteId: string
      edges: number
      /** Where the attachments went; null is unfiled. */
      companyId: string | null
      attachments: AttachmentOutcome
    }
  | { kind: 'duplicate' }

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The entities an address list resolves to — people by email, companies by domain. */
export async function matchParticipants(
  tx: Tx,
  participants: ReadonlyArray<Address>,
): Promise<Array<string>> {
  const emails = [
    ...new Set(
      participants
        .map((p) => normalizeEmail(p.email))
        .filter((e): e is string => e !== null),
    ),
  ]
  const domains = [
    ...new Set(
      participants
        .map((p) =>
          normalizeDomain(p.email.slice(p.email.lastIndexOf('@') + 1)),
        )
        .filter((d): d is string => d !== null),
    ),
  ]
  if (emails.length === 0 && domains.length === 0) return []

  const byKey = [
    ...(emails.length > 0
      ? [
          and(
            eq(entityAlias.kind, 'email'),
            inArray(entityAlias.valueNorm, emails),
          ),
        ]
      : []),
    ...(domains.length > 0
      ? [
          and(
            eq(entityAlias.kind, 'domain'),
            inArray(entityAlias.valueNorm, domains),
          ),
        ]
      : []),
  ]
  // A merged loser still owns its aliases until the executor moves them; the
  // edge goes to the winner it redirects to. Chains are flattened at merge
  // time, so one hop is the whole walk.
  const rows = await tx
    .selectDistinct({
      id: sql<string>`coalesce(${entity.mergedIntoId}, ${entity.id})`,
    })
    .from(entityAlias)
    .innerJoin(entity, eq(entity.id, entityAlias.entityId))
    .where(and(or(...byKey), inArray(entity.kind, ['person', 'company'])))
  return rows.map((r) => r.id)
}

/**
 * The one company a thread's attachments file onto, or null for unfiled —
 * §3.1 entry point 6's "matched company, else unfiled", made singular.
 *
 * One company on the thread is the company. Several — a founder copying a
 * co-investor, a partner introducing two portfolio companies — is settled by
 * the sender: the company the From address resolves to, when it is one of
 * them. Otherwise the deck is ambiguous, and an unfiled document that files
 * with one click is the honest answer; a deck filed on every company on the
 * Cc line is three misfilings to undo.
 */
export function chooseFilingCompany(
  threadCompanies: ReadonlyArray<string>,
  senderEntities: ReadonlyArray<string>,
): string | null {
  const companies = [...new Set(threadCompanies)]
  if (companies.length === 1) return companies[0]
  const sender = companies.filter((c) => senderEntities.includes(c))
  return sender.length === 1 ? sender[0] : null
}

/** The live companies among an edge list. */
async function companiesOf(
  tx: Tx,
  entityIds: ReadonlyArray<string>,
): Promise<Array<string>> {
  if (entityIds.length === 0) return []
  const rows = await tx
    .select({ id: entity.id })
    .from(entity)
    .where(
      and(
        inArray(entity.id, [...entityIds]),
        eq(entity.kind, 'company'),
        isNull(entity.mergedIntoId),
      ),
    )
  return rows.map((r) => r.id)
}

/** People and companies already on this thread — what a reply inherits. */
async function threadEdges(tx: Tx, threadId: string): Promise<Array<string>> {
  const rows = await tx
    .selectDistinct({ id: interactionEntity.entityId })
    .from(interactionEntity)
    .innerJoin(interaction, eq(interaction.id, interactionEntity.interactionId))
    .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
    .where(
      and(
        eq(interaction.threadId, threadId),
        inArray(entity.kind, ['person', 'company']),
        isNull(entity.mergedIntoId),
      ),
    )
  return rows.map((r) => r.id)
}

export const fileArrivalProgram = Effect.fn('fileArrival')(function* (
  message: ArrivalMessage,
  ctx: FileContext,
): Effect.fn.Return<Filed, ArrivalWriteFailed> {
  // Participants → records, through the gate (SPA-86). Before the
  // transaction, and for a duplicate too: a re-read is all attaches.
  const records = yield* participantRecordsProgram(message, ctx).pipe(
    Effect.mapError((e) => new ArrivalWriteFailed({ cause: e.cause })),
  )
  const written = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx): Promise<Filed> => {
        const wrote = await writeIntegrationInteraction(tx, {
          integrationId: ctx.integrationId,
          kind: 'email',
          messageId: message.messageId,
          threadId: message.threadId,
          subject: message.subject,
          occurredAt: message.occurredAt,
          // Forwarding is the consent (D49): a forwarded body is born shared.
          body: {
            title: message.subject ?? '',
            text: message.body,
            authorId: ctx.authorId,
            visibility: 'shared',
          },
          // Matched and inherited after the row exists, as before the
          // extraction: the writer calls this inside the same transaction.
          edges: async () => [
            ...records.entityIds,
            ...(await matchParticipants(tx, message.participants)),
            ...(await threadEdges(tx, message.threadId)),
          ],
        })
        if (wrote.kind === 'duplicate') return wrote
        if (wrote.noteId === null)
          throw new Error('the mailbox writes a body for every interaction')
        const { interactionId, noteId, edges } = wrote

        const companyId = chooseFilingCompany(
          await companiesOf(tx, edges),
          message.from === null
            ? []
            : await matchParticipants(tx, [message.from]),
        )
        return {
          kind: 'written',
          interactionId,
          noteId,
          edges: edges.length,
          companyId,
          attachments: NO_ATTACHMENTS,
        }
      }),
    catch: (cause) => new ArrivalWriteFailed({ cause }),
  })
  if (written.kind === 'duplicate') return written

  const attachments = yield* fileAttachmentsProgram(message.attachments, {
    integrationId: ctx.integrationId,
    subject: message.subject,
    companyId: written.companyId,
  })
  return { ...written, attachments }
})
