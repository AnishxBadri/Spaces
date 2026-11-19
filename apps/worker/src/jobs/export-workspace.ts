import { Effect, Schema } from 'effect'
import { nonEmpty } from '../job-data'
import { QUEUES } from '@spaces/core/queue/names'
import { exportSummary } from '@spaces/core/export/workspace'
import { exportWorkspaceProgram } from '@spaces/core/writes/export/workspace'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * workspace.export: the workspace as one zip, sent by an admin from
 * Settings → General. The summary leads with the zip's digest and size,
 * which the settings row reads back off the settled job to offer Download.
 */

/**
 * How long one export may run before pg-boss takes it back: the zip carries
 * every stored file, which pg-boss's quarter-hour default does not allow for.
 */
export const EXPORT_WORKSPACE_EXPIRE_SECONDS = 2 * 60 * 60

export const exportWorkspaceData = Schema.Struct({ requestedBy: nonEmpty })

export type ExportWorkspaceData = typeof exportWorkspaceData.Type

export const exportWorkspace: JobDef<ExportWorkspaceData> = {
  name: QUEUES.exportWorkspace,
  schema: exportWorkspaceData,
  run: (data) =>
    exportWorkspaceProgram(data).pipe(
      Effect.map(exportSummary),
      // Permanent: the queue never retries, and a broken export is one the
      // admin starts again from the row, which shows this reason.
      Effect.catchTag('WorkspaceExportFailed', (err) =>
        Effect.fail(
          new JobPermanent({
            reason: `The export could not be written: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`,
          }),
        ),
      ),
    ),
}
