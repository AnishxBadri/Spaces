import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import {
  objectPreviewProgram,
  passagePreviewProgram,
  recordPreviewProgram,
} from './preview'
import type { ObjectPreview, PassagePreview, RecordPreview } from './preview'

/** The preview server fns' bodies, out of `lib/server/` so a test can call them. */

export async function previewRecordHandler(data: {
  id: string
}): Promise<RecordPreview> {
  const u = await requireUser()
  return effectFn(recordPreviewProgram)({ id: u.id }, data.id, new Date())
}

export async function previewObjectHandler(data: {
  slug: string
}): Promise<ObjectPreview | null> {
  const u = await requireUser()
  return effectFn(objectPreviewProgram)({ id: u.id }, data.slug)
}

export async function previewPassageHandler(data: {
  id: string
  page: number | null
  snippet: string
}): Promise<PassagePreview> {
  const u = await requireUser()
  return effectFn(passagePreviewProgram)(u.id, data)
}
