import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { formatBytes } from '@spaces/core/documents'
import {
  DefineRow,
  ImportHeader,
  PreviewGrid,
  PreviousImportNotice,
  SheetTabs,
  StepStrip,
} from '#/components/import/import-wizard'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  defineImportBatch,
  discardImportBatch,
  getImportBatch,
  listObjects,
  selectImportSheet,
} from '#/lib/server-fns'
import type { ImportMode } from '#/components/import/import-wizard'

/**
 * `/import/$batchId` — a staged batch (SPA-164): the define row (records
 * into an object from the registry, or the portfolio ledger), the workbook's
 * tabs, and the detected header over the first 20 rows. The escaping `_`
 * keeps it outside `/import`'s component, as `settings_.objects.$objectSlug`
 * stays outside the settings shell.
 */
export const Route = createFileRoute('/_app/import_/$batchId')({
  loader: async ({ params }) => {
    const [batch, objects] = await Promise.all([
      getImportBatch({ data: { batchId: params.batchId } }),
      listObjects(),
    ])
    return { batch, objects }
  },
  component: ImportBatchPage,
})

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? 'file' : filename.slice(dot + 1).toLowerCase()
}

function ImportBatchPage() {
  const { batch, objects } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm, confirmDialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)

  const staged = batch.status === 'staged'
  const target = objects.find((o) => o.id === batch.targetObjectId) ?? null
  const title =
    batch.mode === 'ledger'
      ? 'Import portfolio events from a spreadsheet'
      : target
        ? `Import ${target.plural.toLowerCase()} from a spreadsheet`
        : 'Import from a spreadsheet'

  async function write(run: () => Promise<unknown>) {
    setBusy(true)
    try {
      await run()
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  function define(mode: ImportMode, targetObjectId: string | null) {
    void write(() =>
      defineImportBatch({
        data: { batchId: batch.id, mode, targetObjectId },
      }),
    )
  }

  async function discard() {
    const ok = await confirm({
      title: `Discard ${batch.filename}?`,
      body: 'The staged rows go; nothing was written to your records.',
      action: 'Discard',
    })
    if (!ok) return
    setDiscarding(true)
    try {
      await discardImportBatch({ data: { batchId: batch.id } })
      await navigate({ to: '/import' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not discard')
      setDiscarding(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ImportHeader
        mode={batch.mode}
        title={title}
        readout={
          <span className="tabular">
            {batch.filename} · sheet {batch.sheet} ·{' '}
            {batch.rowCount.toLocaleString('en-US')} rows · {batch.columnCount}{' '}
            columns
          </span>
        }
        discarding={discarding}
        {...(staged ? { onDiscard: () => void discard() } : {})}
      />
      <StepStrip
        uploadHint={`${extensionOf(batch.filename)} · ${formatBytes(batch.sizeBytes)}`}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-8 py-6">
        {batch.previous ? (
          <PreviousImportNotice previous={batch.previous} />
        ) : null}
        <DefineRow
          objects={objects}
          mode={batch.mode}
          targetObjectId={batch.targetObjectId}
          onChange={define}
          disabled={busy || !staged}
        />
        <SheetTabs
          sheets={batch.sheets}
          current={batch.sheet}
          disabled={busy || !staged}
          onSelect={(sheet) =>
            void write(() =>
              selectImportSheet({ data: { batchId: batch.id, sheet } }),
            )
          }
        />
        <PreviewGrid
          header={batch.header}
          columnCount={batch.columnCount}
          rows={batch.preview}
          rowCount={batch.rowCount}
        />
      </div>
      {confirmDialog}
    </div>
  )
}
