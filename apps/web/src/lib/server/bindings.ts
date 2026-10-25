import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * Link a Drive folder (storage bindings): bind, the poll the bind dialog
 * reads, the record's bindings, Unlink, and binding health — an account
 * page's ledgers and Re-bind. Each handler is `requireUser()`
 * plus a bindings program, reached by a dynamic
 * import so Effect and drizzle stay out of the client bundle.
 */

export type {
  BoundFolderRow,
  FolderPick,
  LinkFolderOutcome,
  RecordBindings,
} from '../documents/bindings'

/** A same-origin path, never a URL: where a Connect dance lands. */
const samePath = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)/, 'A path on this site')

const COULD_NOT_LINK = 'Could not link this folder'

export const linkDriveFolder = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      folder: z.union([
        z.object({ url: z.string().url().max(2000) }),
        z.object({
          id: z
            .string()
            .regex(/^[\w-]+$/)
            .max(200),
        }),
      ]),
      attachTo: z.string().uuid(),
      options: z.object({
        mapSubfolders: z.boolean(),
        retain: z.enum(['full', 'text']),
        direction: z.enum(['pull', 'push', 'both']),
        sensitivity: z.enum(['inherit', 'sensitive']),
      }),
      returnTo: samePath,
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { linkFolderProgram } = await import('../documents/bindings')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(linkFolderProgram)(u.id, data)
    } catch {
      throw new Error(COULD_NOT_LINK)
    }
  })

export const linkFolderStatus = createServerFn()
  .validator(z.object({ bindIds: z.array(z.string().uuid()).max(10) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { linkFolderStatusProgram } = await import('../documents/bindings')
    const { effectFn } = await import('./effect')
    return effectFn(linkFolderStatusProgram)(data.bindIds)
  })

export const listRecordBindings = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { recordBindingsForProgram } = await import('../documents/bindings')
    const { effectFn } = await import('./effect')
    return effectFn(recordBindingsForProgram)(u.id, data.entityId)
  })

/** Unlink: the binding row goes; the documents it filed stay, with no binding. */
export const unlinkDriveFolder = createServerFn({ method: 'POST' })
  .validator(z.object({ bindingId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { unlinkFolderProgram } = await import('../documents/bindings')
    const { effectFn } = await import('./effect')
    return { unlinked: await effectFn(unlinkFolderProgram)(data.bindingId) }
  })

/**
 * Keep full copies or text only, after the bind. `text → full` sends one
 * backfill per document whose bytes were dropped; `full → text` drops
 * nothing held until each file is next extracted. Null when the binding is
 * gone.
 * No surface calls it yet. @public
 */
export const setBindingRetain = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      bindingId: z.string().uuid(),
      retain: z.enum(['full', 'text']),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { setBindingRetainProgram } =
      await import('@spaces/core/writes/bindings/retain')
    const { webEnqueue } = await import('../enqueue-live')
    const { Effect } = await import('effect')
    return Effect.runPromise(
      setBindingRetainProgram(data).pipe(Effect.provide(webEnqueue)),
    )
  })

export type {
  AccountBindings,
  BoundFolderHealth,
  RebindChoice,
  RebindQueued,
  RebindStatus,
  WaitingExportLine,
} from '../documents/binding-health'

/**
 * A storage account page's Bound folders and Exports ledgers, and the
 * reader's connections a binding can be re-bound with. Null when the
 * connection is not the reader's.
 */
export const getAccountBindings = createServerFn()
  .validator(z.object({ connectionId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { accountBindingsForProgram } =
      await import('../documents/binding-health')
    const { effectFn } = await import('./effect')
    return effectFn(accountBindingsForProgram)(u.id, data.connectionId)
  })

/**
 * Re-bind with my connection: `commit: false` checks the folder on the
 * reader's connection, `commit: true` checks it again and re-binds. Both are
 * worker jobs the window polls by `checkId`.
 */
export const rebindFolder = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      bindingId: z.string().uuid(),
      connectionId: z.string().uuid(),
      commit: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { rebindFolderProgram } = await import('../documents/binding-health')
    const { effectFn } = await import('./effect')
    return effectFn(rebindFolderProgram)(u.id, data)
  })

export const rebindStatus = createServerFn()
  .validator(z.object({ checkIds: z.array(z.string().uuid()).max(10) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { rebindStatusProgram } = await import('../documents/binding-health')
    const { effectFn } = await import('./effect')
    return effectFn(rebindStatusProgram)(data.checkIds)
  })
