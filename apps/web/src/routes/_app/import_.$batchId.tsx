import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { formatBytes } from '@spaces/core/documents'
import { columnName } from '@spaces/core/import/mapping'
import {
  DefineRow,
  ImportHeader,
  PreviewGrid,
  PreviousImportNotice,
  SheetTabs,
  StepStrip,
} from '#/components/import/import-wizard'
import {
  IdentityStrip,
  MappingGrid,
  targetLabel,
} from '#/components/import/mapping-grid'
import {
  PreviewHeader,
  PreviewLedger,
  PreviewStrip,
} from '#/components/import/preview-ledger'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  beginImportMapping,
  createImportAttribute,
  decideImportCollision,
  defineImportBatch,
  discardImportBatch,
  getImportBatch,
  getImportMapping,
  getImportPreview,
  listObjects,
  mapImportColumn,
  planImport,
  reopenImportMapping,
  selectImportSheet,
} from '#/lib/server-fns'
import type { ImportMode } from '#/components/import/import-wizard'
import type { NewAttributeDraft } from '#/components/import/mapping-grid'
import type { ColumnTarget, Replaced } from '@spaces/core/import/mapping'
import type { CollisionDecision } from '@spaces/core/import/plan'

/**
 * `/import/$batchId` — a staged batch. Step 1 (SPA-164): the define row
 * (records into an object from the registry, or the portfolio ledger), the
 * workbook's tabs, and the detected header over the first 20 rows. Step 2
 * (SPA-165): the same grid with the mapping in its heads. Step 3 (SPA-167):
 * the resolve preview — the verdict sentence, the readout strip and the
 * ledger of stored plans.
 *
 * The step is read off the batch — a mapping on the row is step 2, a
 * planned batch step 3 — so a reload resumes exactly where the operator
 * was. `?show=` is the ledger's filter: a `loaderDeps` key, since it
 * changes which rows the server sends. The escaping `_` keeps the
 * page outside `/import`'s component, as `settings_.objects.$objectSlug`
 * stays outside the settings shell.
 */
const importSearch = z.object({
  show: z
    .enum(['all', 'create', 'attach', 'decide', 'noland'])
    .catch('all')
    .default('all'),
})

export const Route = createFileRoute('/_app/import_/$batchId')({
  validateSearch: importSearch,
  loaderDeps: ({ search }) => ({ show: search.show }),
  loader: async ({ params, deps }) => {
    const [batch, objects, mapping, preview] = await Promise.all([
      getImportBatch({ data: { batchId: params.batchId } }),
      listObjects(),
      getImportMapping({ data: { batchId: params.batchId } }),
      getImportPreview({
        data: { batchId: params.batchId, filter: deps.show },
      }),
    ])
    return { batch, objects, mapping, preview }
  },
  component: ImportBatchPage,
})

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? 'file' : filename.slice(dot + 1).toLowerCase()
}

function ImportBatchPage() {
  const { batch, objects, mapping, preview } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm, confirmDialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [backing, setBacking] = useState(false)

  const staged = batch.status === 'staged'
  const step = mapping ? 1 : 0
  const target = objects.find((o) => o.id === batch.targetObjectId) ?? null
  const title =
    batch.mode === 'ledger'
      ? 'Import portfolio events from a spreadsheet'
      : target
        ? `Import ${target.plural.toLowerCase()} from a spreadsheet`
        : 'Import from a spreadsheet'
  const mappedCount = mapping
    ? mapping.mapping.filter((t) => t.target !== 'ignore').length
    : 0

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

  /** Changing the object or the sheet on step 2 starts the mapping over. */
  async function keepsMapping(what: string): Promise<boolean> {
    if (!mapping) return true
    return confirm({
      title: `Change the ${what}?`,
      body: 'The column mapping starts over from the header.',
      action: `Change ${what}`,
    })
  }

  async function define(mode: ImportMode, targetObjectId: string | null) {
    if (!(await keepsMapping('object'))) return
    void write(() =>
      defineImportBatch({
        data: { batchId: batch.id, mode, targetObjectId },
      }),
    )
  }

  async function selectSheet(sheet: string) {
    if (!(await keepsMapping('sheet'))) return
    void write(() => selectImportSheet({ data: { batchId: batch.id, sheet } }))
  }

  /** Name what a choice took from another column — the only word on it. */
  function sayReplaced(replaced: Array<Replaced>) {
    if (!mapping) return
    for (const r of replaced) {
      toast(
        `${columnName(r.column, batch.header)} no longer maps to ${targetLabel(r.previous, mapping).name}`,
      )
    }
  }

  async function mapColumn(column: number, next: ColumnTarget) {
    await write(async () => {
      const out = await mapImportColumn({
        data: { batchId: batch.id, column, target: next },
      })
      sayReplaced(out.replaced)
    })
  }

  async function createAttribute(column: number, draft: NewAttributeDraft) {
    await write(async () => {
      const out = await createImportAttribute({
        data: {
          batchId: batch.id,
          column,
          name: draft.name,
          type: draft.type,
          options: draft.options,
          dateOrder: draft.dateOrder,
        },
      })
      sayReplaced(out.replaced)
      toast.success(`${draft.name} added to ${target?.plural ?? 'the object'}`)
    })
  }

  /**
   * Step 1 → 2 once records have an object. On step 2 the mapping is
   * checked before anything advances — a refusal names its reason, and a
   * column where nothing parses is called out — and then every row is
   * planned and step 3 opens.
   */
  const canContinue =
    staged &&
    !busy &&
    (step === 1 || (batch.mode === 'records' && batch.targetObjectId !== null))

  function onContinue() {
    if (step === 0) {
      setContinuing(true)
      void write(() =>
        beginImportMapping({ data: { batchId: batch.id } }),
      ).finally(() => setContinuing(false))
      return
    }
    if (!mapping) return
    const first = mapping.problems.at(0)
    const rest = mapping.problems.slice(1)
    if (first) {
      toast.error(first.reason, {
        ...(rest.length > 0
          ? { description: rest.map((p) => p.reason).join(' · ') }
          : {}),
      })
      return
    }
    setContinuing(true)
    void write(() => planImport({ data: { batchId: batch.id } })).finally(() =>
      setContinuing(false),
    )
  }

  /** Step 3 → 2: the stored plan is thrown away with the step. */
  function backToMapping() {
    setBacking(true)
    void write(() =>
      reopenImportMapping({ data: { batchId: batch.id } }),
    ).finally(() => setBacking(false))
  }

  function decide(rowNum: number, decision: CollisionDecision) {
    void write(() =>
      decideImportCollision({ data: { batchId: batch.id, rowNum, decision } }),
    )
  }

  // ⌘↵ is printed inside Continue, so it works wherever Continue does.
  useEffect(() => {
    if (!canContinue) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onContinue()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

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

  const uploadHint = `${extensionOf(batch.filename)} · ${formatBytes(batch.sizeBytes)}`
  const mapHint =
    mapping && mapping.problems.length === 0
      ? `${mappedCount} of ${mapping.mapping.length} mapped`
      : null

  if (preview) {
    return (
      <div className="flex h-full flex-col">
        <PreviewHeader
          counts={preview.counts}
          filename={batch.filename}
          onBack={backToMapping}
          backing={backing}
        />
        <StepStrip step={2} uploadHint={uploadHint} mapHint={mapHint} />
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto pb-6">
          <PreviewStrip counts={preview.counts} batchId={batch.id} />
          <div className="px-8">
            <PreviewLedger
              view={preview}
              batchId={batch.id}
              disabled={busy}
              onDecide={decide}
            />
          </div>
        </div>
        {confirmDialog}
      </div>
    )
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
        continuing={continuing}
        {...(staged ? { onDiscard: () => void discard() } : {})}
        {...(canContinue ? { onContinue } : {})}
      />
      <StepStrip step={step} uploadHint={uploadHint} mapHint={mapHint} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-8 py-6">
        {batch.previous ? (
          <PreviousImportNotice previous={batch.previous} />
        ) : null}
        <DefineRow
          objects={objects}
          mode={batch.mode}
          targetObjectId={batch.targetObjectId}
          onChange={(mode, id) => void define(mode, id)}
          disabled={busy || !staged}
        />
        <SheetTabs
          sheets={batch.sheets}
          current={batch.sheet}
          disabled={busy || !staged}
          onSelect={(sheet) => void selectSheet(sheet)}
        />
        {mapping ? (
          <>
            <IdentityStrip
              view={mapping}
              header={batch.header}
              disabled={busy || !staged}
              onMap={(column, next) => void mapColumn(column, next)}
            />
            <MappingGrid
              view={mapping}
              header={batch.header}
              rows={batch.preview}
              rowCount={batch.rowCount}
              disabled={busy || !staged}
              onMap={mapColumn}
              onCreate={createAttribute}
            />
          </>
        ) : (
          <PreviewGrid
            header={batch.header}
            columnCount={batch.columnCount}
            rows={batch.preview}
            rowCount={batch.rowCount}
          />
        )}
      </div>
      {confirmDialog}
    </div>
  )
}
