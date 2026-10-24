import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * A record's picture set or cleared by hand: held from then on, so
 * enrichment never fills it again. The bytes it replaced are reclaimed
 * once no row names them.
 */

const MAX_FORM_BYTES = 4 * 1024 * 1024

function readPictureForm(data: FormData): { entityId: string; file: File } {
  const entityId = z.uuid().parse(data.get('entityId'))
  const file = data.get('file')
  if (!(file instanceof File)) throw new Error('Choose an image')
  if (file.size > MAX_FORM_BYTES) throw new Error('The picture is too large')
  return { entityId, file }
}

export const setRecordPicture = createServerFn({ method: 'POST' })
  .validator((data: FormData) => readPictureForm(data))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { setPictureProgram } =
      await import('@spaces/core/writes/entities/picture')
    const { reclaimBlobIfOrphaned } = await import('../documents/blob-refs')
    const { pictureUrl } = await import('../records/pictures')
    const { effectFn } = await import('./effect')
    const { sha, previous } = await effectFn(setPictureProgram)({
      entityId: data.entityId,
      bytes: new Uint8Array(await data.file.arrayBuffer()),
      contentType: data.file.type === '' ? null : data.file.type,
      by: u.id,
    })
    if (previous !== null) await reclaimBlobIfOrphaned(previous)
    return { picture: await pictureUrl(sha) }
  })

export const clearRecordPicture = createServerFn({ method: 'POST' })
  .validator(z.object({ entityId: z.uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { clearPictureProgram } =
      await import('@spaces/core/writes/entities/picture')
    const { reclaimBlobIfOrphaned } = await import('../documents/blob-refs')
    const { effectFn } = await import('./effect')
    const { previous } = await effectFn(clearPictureProgram)(data.entityId)
    if (previous !== null) await reclaimBlobIfOrphaned(previous)
    return { picture: null }
  })
