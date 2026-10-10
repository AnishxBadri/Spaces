import { eq } from 'drizzle-orm'
import { entity, interaction, interactionEntity, note } from '@spaces/db/schema'
import type { NoteBody } from '@spaces/db/schema/kinds'
import type { InteractionMeta } from '@spaces/db/schema/interactions'
import { readInteractionMeta } from '../../json'
import type { Tx } from '../entities/resolve'
import { interactionParticipants, recomputeInteractionStats } from './stats'

/**
 * The integration interaction lane (SPA-200, sdk-7b): one interaction, its
 * body note and its edges, written inside the caller's transaction. Two
 * callers, one row shape: the forwarding mailbox (`apps/web/src/lib/arrival/
 * file.ts`, plugin zero) and `Content.logInteraction`
 * (`../ports/content.ts`). The manual "Log interaction" dialog is not a
 * caller — it is `manual`, carries no `message_id` and births its write-up
 * through the note door with a `note.created` row; that path is
 * `apps/web/src/lib/interactions/log.ts` and stays as it was.
 *
 * **The dedupe is the index.** With a `messageId`, the insert is `on conflict
 * (message_id) do nothing` against `interaction_message_id_unique`, and an
 * empty `returning` is the duplicate — nothing checks first, because a
 * pre-check would race a concurrent writer and the index cannot. A
 * duplicate writes nothing else: no body note, no edges. Without a
 * `messageId` there is no key to collide on (NULLs are distinct in a unique
 * index), so every call is a new row, as on the manual path.
 *
 * **The interaction first, then its body, then its edges** — the order the
 * mailbox has always written in, so a duplicate leaves no orphan note and a
 * failed edge insert (the caller's transaction rolls back) leaves no
 * bodyless interaction the next attempt would skip as a duplicate. `edges`
 * may be a function of the transaction, which is how the mailbox matches
 * participants and inherits thread edges after the row exists, exactly as
 * it did before the extraction.
 *
 * **The body is a note**, claimed by `interaction.note_id` and filed against
 * nothing: it reaches a record through the interaction's edges on the
 * timeline. Its visibility is the caller's to decide (D30, D49) — a
 * forwarded body is `shared`, a synced or plugin-written one `private` —
 * and never the writer's.
 *
 * **The stats follow in the same transaction.** Every entity edged is handed
 * to `recomputeInteractionStats` before the writer returns, and
 * `updateInteraction` does the same for a change in place — a cancellation
 * included — so `interaction_stat` cannot disagree with a committed row.
 */

/** A long body is kept whole in `body_md` up to here, not truncated at 1 MB by accident. */
export const MAX_BODY_CHARS = 200_000

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

export type BodyVisibility = 'shared' | 'private'

/** The interaction's write-up, as plain text, and who it is born to. */
export type InteractionBody = {
  /** The note's title — the subject, or '' when there is none. */
  title: string
  /** Plain text; capped at `MAX_BODY_CHARS`. */
  text: string
  /** The workspace user the note is authored by (`note.author_id`). */
  authorId: string
  visibility: BodyVisibility
}

/**
 * The birth of a body note, inside the caller's transaction: the `note`
 * entity (source `integration`, ref the writing row) and its `note` row,
 * filed against nothing. Moved here from `apps/web/src/lib/notes/
 * body-note.ts` with its rows unchanged; only the visibility became the
 * caller's.
 */
export async function insertBodyNote(
  tx: Tx,
  integrationId: string,
  body: InteractionBody,
): Promise<string> {
  const text = body.text.slice(0, MAX_BODY_CHARS)
  const noteEntity = (
    await tx
      .insert(entity)
      .values({
        kind: 'note',
        canonicalName: body.title || 'Untitled',
        createdBy: body.authorId,
        sourceClass: 'integration',
        sourceRef: integrationId,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!noteEntity) throw new Error('note entity insert returned no row')
  await tx.insert(note).values({
    entityId: noteEntity.id,
    authorId: body.authorId,
    title: body.title,
    kind: 'note',
    bodyJson: bodyBlocks(text),
    bodyMd: text,
    visibility: body.visibility,
  })
  return noteEntity.id
}

export type IntegrationInteraction = {
  /** The integration row that wrote it — `source_ref` on every row. */
  integrationId: string
  kind: 'email' | 'meeting' | 'call'
  /** The dedupe key; null is a new row every time. */
  messageId: string | null
  threadId: string | null
  subject: string | null
  occurredAt: Date
  /** Per-kind metadata; its `kind` must be this row's. Omitted writes null. */
  meta?: InteractionMeta
  /** Null writes no note and leaves `note_id` null. */
  body: InteractionBody | null
  /** The entities to edge — given, or derived inside the transaction once the row exists. */
  edges: ReadonlyArray<string> | ((tx: Tx) => Promise<ReadonlyArray<string>>)
}

export type WrittenInteraction =
  | {
      kind: 'written'
      interactionId: string
      noteId: string | null
      /** Every entity edged, deduplicated, in the order given. */
      edges: Array<string>
    }
  | { kind: 'duplicate' }

export async function writeIntegrationInteraction(
  tx: Tx,
  input: IntegrationInteraction,
): Promise<WrittenInteraction> {
  const meta = readInteractionMeta(input.kind, input.meta ?? null)
  if (!meta.ok) throw new Error(`interaction meta refused — ${meta.reason}`)
  const insert = tx.insert(interaction).values({
    kind: input.kind,
    sourceClass: 'integration',
    sourceRef: input.integrationId,
    messageId: input.messageId,
    threadId: input.threadId,
    subject: input.subject,
    meta: meta.meta,
    occurredAt: input.occurredAt,
  })
  const row = (
    input.messageId === null
      ? await insert.returning({ id: interaction.id })
      : await insert
          .onConflictDoNothing({ target: interaction.messageId })
          .returning({ id: interaction.id })
  ).at(0)
  if (!row) {
    if (input.messageId === null)
      throw new Error('interaction insert returned no row')
    return { kind: 'duplicate' }
  }

  let noteId: string | null = null
  if (input.body !== null) {
    noteId = await insertBodyNote(tx, input.integrationId, input.body)
    await tx
      .update(interaction)
      .set({ noteId })
      .where(eq(interaction.id, row.id))
  }

  const given =
    typeof input.edges === 'function' ? await input.edges(tx) : input.edges
  const edges = [...new Set(given)]
  for (const entityId of edges) {
    await tx
      .insert(interactionEntity)
      .values({ interactionId: row.id, entityId })
      .onConflictDoNothing()
  }
  await recomputeInteractionStats(tx, edges)
  return { kind: 'written', interactionId: row.id, noteId, edges }
}

/** What a sync may change on an interaction it wrote earlier. */
export type InteractionChange = {
  subject?: string | null
  occurredAt?: Date
  /** Replaces the whole `meta`; its `kind` must be the row's. */
  meta?: InteractionMeta
}

/**
 * An interaction changed in place — a meeting moved, renamed or cancelled
 * (D68: a cancelled meeting is marked, never deleted). Its participants'
 * stats are rebuilt in the same transaction. Returns false when no such row.
 */
export async function updateInteraction(
  tx: Tx,
  interactionId: string,
  change: InteractionChange,
): Promise<boolean> {
  const current = (
    await tx
      .select({ kind: interaction.kind })
      .from(interaction)
      .where(eq(interaction.id, interactionId))
  ).at(0)
  if (!current) return false
  let meta: InteractionMeta | null | undefined
  if (change.meta !== undefined) {
    const read = readInteractionMeta(current.kind, change.meta)
    if (!read.ok) throw new Error(`interaction meta refused — ${read.reason}`)
    meta = read.meta
  }
  await tx
    .update(interaction)
    .set({
      ...(change.subject === undefined ? {} : { subject: change.subject }),
      ...(change.occurredAt === undefined
        ? {}
        : { occurredAt: change.occurredAt }),
      ...(meta === undefined ? {} : { meta }),
    })
    .where(eq(interaction.id, interactionId))
  await recomputeInteractionStats(
    tx,
    await interactionParticipants(tx, interactionId),
  )
  return true
}
