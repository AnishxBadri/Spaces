import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

const uuid = Schema.String.check(Schema.isUUID())

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
const samePath = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.isPattern(/^\/(?!\/)/, { message: 'A path on this site' }),
)

/**
 * A link as a person pastes it: trimmed, then anything `URL` parses — the
 * scheme is not pinned, so a `mailto:` passes and the program refuses it.
 */
const pastedUrl = Schema.Trim.check(
  Schema.makeFilter((s: string) => URL.canParse(s), { expected: 'a URL' }),
  Schema.isMaxLength(2000),
)

const COULD_NOT_LINK = 'Could not link this folder'

export const linkDriveFolder = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        folder: Schema.Union([
          Schema.Struct({ url: pastedUrl }),
          Schema.Struct({
            id: Schema.String.check(
              Schema.isPattern(/^[\w-]+$/),
              Schema.isMaxLength(200),
            ),
          }),
        ]),
        attachTo: uuid,
        options: Schema.Struct({
          mapSubfolders: Schema.Boolean,
          retain: Schema.Literals(['full', 'text']),
          direction: Schema.Literals(['pull', 'push', 'both']),
          sensitivity: Schema.Literals(['inherit', 'sensitive']),
        }),
        returnTo: samePath,
      }),
    ),
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
  .validator(
    input(
      Schema.Struct({
        bindIds: Schema.Array(uuid).check(Schema.isMaxLength(10)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { linkFolderStatusProgram } = await import('../documents/bindings')
    const { effectFn } = await import('./effect')
    return effectFn(linkFolderStatusProgram)(data.bindIds)
  })

export const listRecordBindings = createServerFn()
  .validator(input(Schema.Struct({ entityId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { recordBindingsForProgram } = await import('../documents/bindings')
    const { effectFn } = await import('./effect')
    return effectFn(recordBindingsForProgram)(u.id, data.entityId)
  })

/** Unlink: the binding row goes; the documents it filed stay, with no binding. */
export const unlinkDriveFolder = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ bindingId: uuid })))
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
    input(
      Schema.Struct({
        bindingId: uuid,
        retain: Schema.Literals(['full', 'text']),
      }),
    ),
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
  .validator(input(Schema.Struct({ connectionId: uuid })))
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
    input(
      Schema.Struct({
        bindingId: uuid,
        connectionId: uuid,
        commit: Schema.Boolean,
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { rebindFolderProgram } = await import('../documents/binding-health')
    const { effectFn } = await import('./effect')
    return effectFn(rebindFolderProgram)(u.id, data)
  })

export const rebindStatus = createServerFn()
  .validator(
    input(
      Schema.Struct({
        checkIds: Schema.Array(uuid).check(Schema.isMaxLength(10)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { rebindStatusProgram } = await import('../documents/binding-health')
    const { effectFn } = await import('./effect')
    return effectFn(rebindStatusProgram)(data.checkIds)
  })
