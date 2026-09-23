import { and, eq } from 'drizzle-orm'
import type { db } from '@spaces/db'
import { chunk } from '@spaces/db/schema'
import type { entity } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'

/**
 * Which texts beyond a document's are chunked, and the enqueue that gets
 * them chunked (SPA-132; docs/spec-ai-substrate.md §7 and §9 — "embed on
 * `document.extracted` (and note save, `close_reason`) with no dialog").
 *
 * Kept light on purpose: the write paths that decide *when* a source needs
 * re-chunking — `saveNoteProgram` and `setValuesInTx` — import this and not
 * the embed program, which pulls in every provider adapter. The worker's
 * `chunk.embed` job (`worker/jobs/embed-source.ts`) runs the program.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

type EntityKind = (typeof entity.$inferSelect)['kind']

/** The two sources this module enqueues; documents have `document.embed`. */
export type EmbedSource =
  | { entityId: string; sourceKind: 'note'; sourceKey: '' }
  | { entityId: string; sourceKind: 'attribute'; sourceKey: string }

/**
 * The attribute values that are chunked, by the kind of record carrying
 * them. A write through the one write path to one of these enqueues the
 * embed after commit, and a clear deletes its chunks in the write's own
 * transaction (`lib/attributes/values.ts`). Keyed by kind as well as slug so
 * a custom object's own `close_reason` is not swept in by name.
 *
 * Adding one is adding a line: the reader (`lib/ai/embed-source.ts`) takes
 * any text value, and the semantic lane joins `chunk` on `entity_id` without
 * filtering `source_kind`, so a new entry is searchable with no query change.
 */
export const EMBEDDABLE_ATTRIBUTES: ReadonlyArray<{
  kind: EntityKind
  slug: string
}> = [{ kind: 'deal', slug: 'close_reason' }]

export function isEmbeddableAttribute(kind: string, slug: string): boolean {
  return EMBEDDABLE_ATTRIBUTES.some((a) => a.kind === kind && a.slug === slug)
}

export const noteSource = (entityId: string): EmbedSource => ({
  entityId,
  sourceKind: 'note',
  sourceKey: '',
})

export const attributeSource = (
  entityId: string,
  slug: string,
): EmbedSource => ({ entityId, sourceKind: 'attribute', sourceKey: slug })

/**
 * One queued job per source at a time: `chunk.embed` is created with the
 * `stately` policy (one queued and one active per key), so the burst of
 * autosaves a note sends while someone types coalesces into the one queued
 * job — which reads the latest body when it runs — while a save that lands
 * after that job started queues exactly one more.
 */
export const embedSourceKey = (s: EmbedSource): string =>
  `${s.sourceKind}:${s.sourceKey}:${s.entityId}`

/** Never throws, like every enqueue: a failed send leaves the old chunks. */
export function enqueueSourceEmbed(s: EmbedSource): Promise<string | null> {
  return enqueue(
    QUEUES.embedSource,
    { entityId: s.entityId, sourceKind: s.sourceKind, sourceKey: s.sourceKey },
    { singletonKey: embedSourceKey(s) },
  )
}

/** A source's chunks, gone — the clear half, inside the caller's write. */
export async function deleteSourceChunks(
  tx: Tx,
  s: EmbedSource,
): Promise<void> {
  await tx
    .delete(chunk)
    .where(
      and(
        eq(chunk.entityId, s.entityId),
        eq(chunk.sourceKind, s.sourceKind),
        eq(chunk.sourceKey, s.sourceKey),
      ),
    )
}
