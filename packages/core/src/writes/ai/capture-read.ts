import { eq } from 'drizzle-orm'
import type { db } from '@spaces/db'
import { aiRun, objectDef } from '@spaces/db/schema'
import { CORE_OBJECTS, OBJECT_KINDS } from '@spaces/core/attributes/registry'
import type { ObjectKind } from '@spaces/core/attributes/registry'
import type { Tx } from '@spaces/core/writes/attributes/values'

/**
 * A captured page, read. A capture names nobody we hold a record for, so its
 * proposals anchor on the captured document's own entity and are read against
 * the object the capture declared (`person`, `company` or a custom slug).
 *
 * - The declared object lives in the run's `ai_run.task`
 *   (`Read captured page · <slug>`); each suggestion carries `run_id`, so
 *   propose, accept and the inbox recover it in one read.
 * - No column: an object's slug is minted once and never renamed.
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
