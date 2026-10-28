import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

export type { RecordArchive } from '@spaces/core/writes/entities/archive'

/**
 * Archive and restore for a company, person, deal or custom record, and the
 * read its page shows the archived state from. Any member may archive;
 * archive asks nothing and Restore undoes it. Nothing but server fns may be
 * exported from this file: it is re-exported to the client bundle.
 */

const byRecord = z.object({ id: z.string().uuid() })

export const getRecordArchive = createServerFn()
  .validator(byRecord)
  .handler(async ({ data }) => {
    await requireUser()
    const { recordArchiveProgram } =
      await import('@spaces/core/writes/entities/archive')
    const { effectFn } = await import('./effect')
    return effectFn(recordArchiveProgram)(data.id)
  })

export const archiveRecord = createServerFn({ method: 'POST' })
  .validator(byRecord)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { archiveRecordProgram, recordArchiveMessage } =
      await import('@spaces/core/writes/entities/archive')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(archiveRecordProgram)(u.id, data.id)
    } catch (failure) {
      throw new Error(recordArchiveMessage(failure))
    }
  })

export const restoreRecord = createServerFn({ method: 'POST' })
  .validator(byRecord)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { restoreRecordProgram, recordArchiveMessage } =
      await import('@spaces/core/writes/entities/archive')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(restoreRecordProgram)(u.id, data.id)
    } catch (failure) {
      throw new Error(recordArchiveMessage(failure))
    }
  })
