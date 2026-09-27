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
import type { NoteBody } from '@spaces/db/schema/kinds'
import { insertBodyNote } from '#/lib/notes/body-note'
import type { Address } from './forwarded'
import type { ArrivalMessage } from './message'
import { participantRecordsProgram } from './participant-records'

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
  | { kind: 'written'; interactionId: string; noteId: string; edges: number }
  | { kind: 'duplicate' }

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** A long mail is kept whole in `body_md` and capped here, not truncated at 1 MB by accident. */
const MAX_BODY_CHARS = 200_000

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

/** Plain text → BlockNote paragraphs, one per line, so the editor opens it. */
export function bodyBlocks(text: string): NoteBody {
  return text.split('\n').map((line) =>
    line.trim() === ''
      ? { type: 'paragraph', content: [] }
      : {
          type: 'paragraph',
          content: [
            { type: 'text', text: line.replace(/\s+$/, ''), styles: {} },
          ],
        },
  )
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
  return yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx): Promise<Filed> => {
        const row = (
          await tx
            .insert(interaction)
            .values({
              kind: 'email',
              sourceClass: 'integration',
              sourceRef: ctx.integrationId,
              messageId: message.messageId,
              threadId: message.threadId,
              subject: message.subject,
              occurredAt: message.occurredAt,
            })
            .onConflictDoNothing({ target: interaction.messageId })
            .returning({ id: interaction.id })
        ).at(0)
        if (!row) return { kind: 'duplicate' }

        const body = message.body.slice(0, MAX_BODY_CHARS)
        const title = message.subject ?? ''
        const noteId = await insertBodyNote(tx, {
          title,
          bodyJson: bodyBlocks(body),
          bodyMd: body,
          authorId: ctx.authorId,
          integrationId: ctx.integrationId,
        })
        await tx
          .update(interaction)
          .set({ noteId })
          .where(eq(interaction.id, row.id))

        const matched = await matchParticipants(tx, message.participants)
        const inherited = await threadEdges(tx, message.threadId)
        const edges = [
          ...new Set([...records.entityIds, ...matched, ...inherited]),
        ]
        for (const entityId of edges) {
          await tx
            .insert(interactionEntity)
            .values({ interactionId: row.id, entityId })
            .onConflictDoNothing()
        }
        return {
          kind: 'written',
          interactionId: row.id,
          noteId,
          edges: edges.length,
        }
      }),
    catch: (cause) => new ArrivalWriteFailed({ cause }),
  })
})
