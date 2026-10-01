import { eq } from 'drizzle-orm'
import type { db } from '@spaces/db'
import { aiRun, objectDef } from '@spaces/db/schema'
import { CORE_OBJECTS, OBJECT_KINDS } from '@spaces/core/attributes/registry'
import type { ObjectKind } from '@spaces/core/attributes/registry'
import type { Tx } from '@spaces/core/writes/attributes/values'

/**
 * A captured page, read (SPA-134; CONTEXT.md integration map #8). A capture
 * names nobody we hold a record for, so what the deck reader proposes off it
 * is anchored on the **captured document's own entity** — documents are
 * entities — and read against the registry of the object the capture
 * declared (`person` for a profile, `company` for a company page, or a
 * custom object's slug).
 *
 * The declared object is kept where the run log already keeps what an
 * action was: the `ai_run.task` it ran under, `Read captured page · <slug>`
 * — the shape a column run names itself by (`columnRunTask`), and what
 * Settings → Usage lists it as. Every suggestion the read writes carries
 * that run (`suggestion.run_id`), so the object a document-anchored patch is
 * held to is one read away for the three places that need it:
 * `writes/suggestions/propose.ts` (validate at propose, and at accept in
 * apps/web's `lib/ai/propose.ts`), and apps/web's `lib/inbox/queue.ts`
 * (draw the fields). Moved here from apps/web by SPA-204 with the propose
 * writer that reads it. No column, no migration: the slug is the object's key, and an
 * object's slug is minted once and never renamed.
 */

export const CAPTURE_READ_TASK = 'Read captured page'

const PREFIX = `${CAPTURE_READ_TASK} · `

/** The run's task for a capture read against one object. */
export const captureReadTask = (objectSlug: string): string =>
  `${PREFIX}${objectSlug}`

/** The declared object's slug, when `task` is a capture read's; else null. */
export function captureReadSlug(task: string): string | null {
  if (!task.startsWith(PREFIX)) return null
  const slug = task.slice(PREFIX.length).trim()
  return slug === '' ? null : slug
}

/** The object a capture was read against, as the readers need it. */
export type CaptureObject = {
  id: string
  slug: string
  singular: string
  /** The core kind the object is, or null for a custom object. */
  kind: ObjectKind | null
}

/** A system object whose slug is a core kind's is that kind. */
export function coreKindOf(object: {
  slug: string
  isSystem: boolean
}): ObjectKind | null {
  if (!object.isSystem) return null
  return OBJECT_KINDS.find((k) => CORE_OBJECTS[k].slug === object.slug) ?? null
}

type Reader = Tx | typeof db

/** One object by slug, archived or not: a read already made stands. */
export async function captureObjectBySlug(
  reader: Reader,
  slug: string,
): Promise<CaptureObject | null> {
  const row = (
    await reader
      .select({
        id: objectDef.id,
        slug: objectDef.slug,
        singular: objectDef.singular,
        isSystem: objectDef.isSystem,
      })
      .from(objectDef)
      .where(eq(objectDef.slug, slug))
  ).at(0)
  return row === undefined
    ? null
    : {
        id: row.id,
        slug: row.slug,
        singular: row.singular,
        kind: coreKindOf(row),
      }
}

/** One object by id — what the capture job is handed. */
export async function captureObjectById(
  reader: Reader,
  id: string,
): Promise<CaptureObject | null> {
  const row = (
    await reader
      .select({ slug: objectDef.slug })
      .from(objectDef)
      .where(eq(objectDef.id, id))
  ).at(0)
  return row === undefined ? null : captureObjectBySlug(reader, row.slug)
}

/**
 * The object a suggestion's run read its page against — null for a
 * suggestion no capture read made (every record-anchored one).
 */
export async function captureObjectOfRun(
  reader: Reader,
  runId: string | null,
): Promise<CaptureObject | null> {
  if (runId === null) return null
  const run = (
    await reader
      .select({ task: aiRun.task })
      .from(aiRun)
      .where(eq(aiRun.id, runId))
  ).at(0)
  const slug = run === undefined ? null : captureReadSlug(run.task)
  return slug === null ? null : captureObjectBySlug(reader, slug)
}
