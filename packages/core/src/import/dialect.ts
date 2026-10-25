import { z } from 'zod'
import { manifestSchema } from '@spaces/sdk'
import { pluginQueueName } from '../queue/names'
import type { PluginQueueName } from '../queue/names'

/**
 * A dialect plugin as the import wizard sees it: a `file`

 * job that `uses` Import and `accepts` the dropped file's name. Read from
 * the stored manifest — web never loads a bundle.
 */

/**
 * What a queued `file` job carries: the stored bytes by digest, and the
 * waiting batch when the import wizard sent it.
 */
export const fileJobData = z.object({
  blobSha: z.string().regex(/^[0-9a-f]{64}$/),
  filename: z.string().min(1),
  mime: z.string().nullable(),
  batchId: z.uuid().optional(),
})

export type FileJobData = z.infer<typeof fileJobData>

export type ImportReader = {
  readonly pluginId: string
  readonly pluginName: string
  readonly job: string
  readonly queue: PluginQueueName
}

/**
 * The job of this manifest that reads a dropped file of this name into an
 * import batch, or null. A manifest that no longer decodes offers none; the
 * first matching job, in manifest order, wins.
 */
export const importReaderOf = (
  manifest: unknown,
  filename: string,
): ImportReader | null => {
  const parsed = manifestSchema.safeParse(manifest)
  if (!parsed.success) return null
  const m = parsed.data
  for (const [job, declared] of Object.entries(m.jobs)) {
    if (declared.trigger !== 'file' || !declared.uses.includes('Import'))
      continue
    const pattern = declared.accepts?.filename
    if (pattern === undefined || !new RegExp(pattern, 'i').test(filename))
      continue
    return {
      pluginId: m.id,
      pluginName: m.name,
      job,
      queue: pluginQueueName(m.id, job, declared.interactive === true),
    }
  }
  return null
}
