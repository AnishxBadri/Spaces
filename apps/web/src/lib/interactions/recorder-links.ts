import { Effect, Schema } from 'effect'
import { eq, inArray, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  entity,
  integration,
  interaction,
  interactionNote,
  note,
} from '@spaces/db/schema'
import { integrationName } from '@spaces/core/plugins/name'
import { parseRecorderKey } from '@spaces/core/writes/interactions/recorded-note'

/**
 * "Open in <provider>" for the notes a recorder filed (D78): the note's
 * `web_url`, kept on its recorder event in `interaction.meta`.
 * - A note matches the event its integration wrote through its author's
 *   connection, or a webhook recorder's, which has none.
 */

export type RecorderLink = { provider: string; url: string }

export class RecorderLinkReadFailed extends Schema.TaggedError<RecorderLinkReadFailed>()(
  'RecorderLinkReadFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RecorderLinkReadFailed({ cause }),
  })

/** A note as the match reads it: who wrote it, and which integration filed it. */
export type RecorderNote = {
  id: string
  authorId: string
  sourceRef: string | null
}

/** Each of `notes` on one interaction that a recorder filed, with its link. */
export const recorderLinksProgram = Effect.fn('recorderLinks')(function* (
  interactionId: string,
  notes: ReadonlyArray<RecorderNote>,
): Effect.fn.Return<Map<string, RecorderLink>, RecorderLinkReadFailed> {
  const out = new Map<string, RecorderLink>()
  if (!notes.some((n) => n.sourceRef !== null)) return out
  const meta = (yield* query(() =>
    db
      .select({ meta: interaction.meta })
      .from(interaction)
      .where(eq(interaction.id, interactionId)),
  )).at(0)?.meta
  const events =
    meta?.kind === 'meeting'
      ? (meta.recorder_events ?? [])
      : meta?.kind === 'call'
        ? [meta]
        : []
  const linked = events.flatMap((e) => {
    const key = parseRecorderKey(e.provider_event_id)
    return key === null || e.web_url === undefined
      ? []
      : [{ ...key, url: e.web_url }]
  })
  if (linked.length === 0) return out

  const connections = [...new Set(linked.flatMap((l) => l.connectionId ?? []))]
  const owners = new Map(
    (connections.length === 0
      ? []
      : yield* query(() =>
          db
            .select({
              id: accountConnection.id,
              userId: accountConnection.userId,
            })
            .from(accountConnection)
            .where(inArray(accountConnection.id, connections)),
        )
    ).map((c) => [c.id, c.userId]),
  )
  const names = new Map(
    (yield* query(() =>
      db
        .select({
          id: integration.id,
          capabilityId: integration.capabilityId,
          manifest: integration.manifest,
        })
        .from(integration)
        .where(
          inArray(integration.id, [
            ...new Set(linked.map((l) => l.integrationId)),
          ]),
        ),
    )).map((i) => [i.id, integrationName(i)]),
  )
  for (const n of notes) {
    const hit = linked.find(
      (l) =>
        l.integrationId === n.sourceRef &&
        (l.connectionId === null || owners.get(l.connectionId) === n.authorId),
    )
    if (hit !== undefined)
      out.set(n.id, {
        provider: names.get(hit.integrationId) ?? 'the recorder',
        url: hit.url,
      })
  }
  return out
})

/** The link on a note's own head: through the interaction that carries it. */
export const noteRecorderLinkProgram = Effect.fn('noteRecorderLink')(function* (
  noteId: string,
): Effect.fn.Return<RecorderLink | null, RecorderLinkReadFailed> {
  const held = (yield* query(() =>
    db
      .select({
        authorId: note.authorId,
        sourceClass: entity.sourceClass,
        sourceRef: entity.sourceRef,
      })
      .from(note)
      .innerJoin(entity, eq(entity.id, note.entityId))
      .where(eq(note.entityId, noteId)),
  )).at(0)
  if (held === undefined || held.sourceClass !== 'integration') return null
  const carrier = (yield* query(() =>
    db
      .selectDistinct({ id: interaction.id })
      .from(interaction)
      .leftJoin(
        interactionNote,
        eq(interactionNote.interactionId, interaction.id),
      )
      .where(
        or(eq(interaction.noteId, noteId), eq(interactionNote.noteId, noteId)),
      )
      .limit(1),
  )).at(0)
  if (carrier === undefined) return null
  const links = yield* recorderLinksProgram(carrier.id, [
    { id: noteId, authorId: held.authorId, sourceRef: held.sourceRef },
  ])
  return links.get(noteId) ?? null
})
