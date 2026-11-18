import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { requireAdmin, requireSettingsReader } from './shared'

export type { WorkspaceExport } from '../import/workspace-export'

/**
 * Settings → General · Export: the row's state, the press that starts the
 * export on the worker, and the zip's download link. The programs are
 * imported inside the handlers, so their database and storage code never
 * reaches the client bundle.
 */

/** The row's state. Any member reads it; a member's row is read-only. */
export const getWorkspaceExport = createServerFn().handler(async () => {
  await requireSettingsReader()
  const { workspaceExportProgram } = await import('../import/workspace-export')
  const { effectFn } = await import('./effect')
  return effectFn(workspaceExportProgram)()
})

/** Sends the export as the admin who pressed. Admin. */
export const startWorkspaceExport = createServerFn({ method: 'POST' }).handler(
  async () => {
    const admin = await requireAdmin()
    const { startWorkspaceExportProgram } =
      await import('../import/workspace-export')
    const { effectFn } = await import('./effect')
    return effectFn(startWorkspaceExportProgram)(admin.id)
  },
)

/**
 * A five-minute signed link to the zip while its day lasts. Admin: the zip
 * holds the whole workspace.
 */
export const downloadWorkspaceExport = createServerFn({
  method: 'POST',
}).handler(async () => {
  await requireAdmin()
  const { workspaceExportUrlProgram, workspaceExportMessage } =
    await import('../import/workspace-export')
  return Effect.runPromise(
    workspaceExportUrlProgram().pipe(
      Effect.mapError((e) => new Error(workspaceExportMessage(e))),
    ),
  )
})
