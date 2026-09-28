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
  refuseContinue,
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
import {
  MissingRateLine,
  ReceiptHeader,
  ReceiptLedger,
  ReceiptStrip,
  VoidLine,
} from '#/components/import/commit-receipt'
import { LedgerMappingStep } from '#/components/import/ledger-mapping'
import { LedgerPreviewStep } from '#/components/import/ledger-preview'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  beginImportMapping,
  beginLedgerMapping,
  commitImport,
  createImportAttribute,
  decideImportCollision,
  defineImportBatch,
  discardImportBatch,
  getImportBatch,
  getImportMapping,
  getImportPreview,
  getImportReceipt,
  getLedgerImport,
  listObjects,
  mapImportColumn,
  planImport,
  reopenImportMapping,
  selectImportSheet,
  voidLedgerBatch,
} from '#/lib/server-fns'
import type { ImportMode } from '#/components/import/import-wizard'
import type { NewAttributeDraft } from '#/components/import/mapping-grid'
import type { ColumnTarget, Replaced } from '@spaces/core/import/mapping'
import type { CollisionDecision } from '@spaces/core/import/plan'
import { landingRows } from '@spaces/core/import/plan'

/**
 * `/import/$batchId` — a staged batch. Step 1 (SPA-164): the define row
 * (records into an object from the registry, or the portfolio ledger), the
 * workbook's tabs, and the detected header over the first 20 rows. Step 2
 * (SPA-165): the same grid with the mapping in its heads. Step 3 (SPA-167):
 * the resolve preview — the verdict sentence, the readout strip and the
 * ledger of stored plans. Step 4 (SPA-169): the commit's receipt — the
 * strip, the rows filling with their outcomes as the job passes them.
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
  /** Step 4's filter (SPA-169): every row, or the ones that failed. */
  outcome: z.enum(['all', 'failed']).catch('all').default('all'),
})

export const Route = createFileRoute('/_app/import_/$batchId')({
  validateSearch: importSearch,
  loaderDeps: ({ search }) => ({
    show: search.show,
    outcome: search.outcome,
  }),
  loader: async ({ params, deps }) => {
    const batchId = params.batchId
    const batchRead = getImportBatch({ data: { batchId } })
    // The ledger steps' data answers null for a records batch, so only a
    // ledger batch asks for it — chained on the batch, beside the rest.
    const ledgerRead = batchRead.then((b) =>
      b.mode === 'ledger' ? getLedgerImport({ data: { batchId } }) : null,
    )
    const [batch, objects, mapping, preview, ledger, receipt] =
      await Promise.all([
        batchRead,
        listObjects(),
        getImportMapping({ data: { batchId } }),
        getImportPreview({ data: { batchId, filter: deps.show } }),
        ledgerRead,
        getImportReceipt({ data: { batchId, filter: deps.outcome } }),
      ])
    return { batch, objects, mapping, preview, ledger, receipt }
  },
  component: ImportBatchPage,
})

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? 'file' : filename.slice(dot + 1).toLowerCase()
}

function ImportBatchPage() {
  const { batch, objects, mapping, preview, ledger, receipt } =
    Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm, confirmDialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [backing, setBacking] = useState(false)
  const [committing, setCommitting] = useState<'commit' | 'retry' | null>(null)
  const [voiding, setVoiding] = useState(false)

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
    (step === 1 || batch.mode === 'ledger' || batch.targetObjectId !== null)

  function onContinue() {
    if (step === 0) {
      refuseContinue([])
      setContinuing(true)
      const begin =
        batch.mode === 'ledger' ? beginLedgerMapping : beginImportMapping
      void write(() => begin({ data: { batchId: batch.id } })).finally(() =>
        setContinuing(false),
      )
      return
    }
    if (!mapping) return
    if (refuseContinue(mapping.problems)) return
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

  /**
   * Commit, or Retry failed rows: the job is enqueued keyed by the batch,
   * and the page turns into its receipt on the next load.
   */
  function commit(onlyFailed: boolean) {
    setCommitting(onlyFailed ? 'retry' : 'commit')
    void write(async () => {
      const out = await commitImport({
        data: { batchId: batch.id, onlyFailed },
      })
      if (!out.queued) toast('A commit of this import is already running')
    }).finally(() => setCommitting(null))
  }

  const ledgerLanding = ledger?.preview
    ? ledger.preview.counts.total - ledger.preview.counts.noLand
    : 0
  const canCommit =
    receipt === null &&
    ((preview !== null &&
      preview.counts.collide === 0 &&
      landingRows(preview.counts) > 0) ||
      ledgerLanding > 0)

  /**
   * Void a committed ledger batch through the shipped reversal path (D12):
   * every investment, mark and distribution it appended gets its
   * compensating event; its rounds stay.
   */
  async function voidBatch() {
    if (!receipt?.ledger) return
    const ok = await confirm({
      title: `Void ${batch.filename}?`,
      body: 'Every investment, mark and distribution this import appended gets a compensating entry, dated as the original. Rounds stay. Nothing is deleted.',
      action: 'Void batch',
    })
    if (!ok) return
    setVoiding(true)
    void write(async () => {
      const out = await voidLedgerBatch({ data: { batchId: batch.id } })
      toast.success(`${out.reversed.toLocaleString('en-US')} entries voided`)
    }).finally(() => setVoiding(false))
  }

  /**
   * After a void the re-run is `Re-import ›` under the voided line, and it
   * asks first. It is the same commit as `Commit again`: a row the batch
   * already committed is passed over, voided or not.
   */
  async function reimport() {
    const ok = await confirm({
      title: `Re-import ${batch.filename}?`,
      body: 'The commit runs again over this batch. Rows it already committed are passed over, voided or not; to append these events again, upload the sheet as a new import.',
      action: 'Re-import',
    })
    if (ok) commit(false)
  }

  /**
   * Progress by polling, deliberately: while a run is live the receipt is
   * re-read every 1.5 s, and every read comes from `import_row`, `job_run`
   * and the queue, so a reopened page recovers exactly where the commit is.
   * sdk-18's SSE stream is the upgrade this does not build — when it lands,
   * the interval becomes a subscription and nothing else changes.
   */
  const live = receipt?.running ?? false
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => void router.invalidate(), 1500)
    return () => window.clearInterval(timer)
  }, [live, router])

  // ⌘↵ is printed inside Continue and Commit, so it works wherever they do.
  useEffect(() => {
    // A voided batch's re-run asks first, so ⌘↵ does not reach it.
    const armed = receipt
      ? !receipt.running &&
        committing === null &&
        !(receipt.ledger?.voided ?? false)
      : canCommit && !busy
    if (!canContinue && !armed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (armed) commit(false)
        else onContinue()
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

  // Step 4 comes first: a ledger batch is still `planned` while its commit
  // runs, and its receipt (SPA-171) is the page from the first row on.
  if (receipt) {
    return (
      <div className="flex h-full flex-col">
        <ReceiptHeader
          view={receipt}
          filename={batch.filename}
          onCommit={() => commit(false)}
          onRetry={() => commit(true)}
          pending={committing}
        />
        <StepStrip
          step={3}
          mode={batch.mode}
          uploadHint={uploadHint}
          mapHint={mapHint ?? 'mapped'}
          previewHint={`${batch.rowCount.toLocaleString('en-US')} rows`}
        />
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto pb-6">
          <div className="flex flex-col gap-3">
            <ReceiptStrip
              counts={receipt.counts}
              batchId={batch.id}
              ledger={receipt.ledger?.counts ?? null}
            />
            {receipt.ledger ? (
              <MissingRateLine ledger={receipt.ledger} />
            ) : null}
          </div>
          <div className="px-8">
            {receipt.ledger ? (
              <VoidLine
                ledger={receipt.ledger}
                voiding={voiding}
                onVoid={() => void voidBatch()}
                onReimport={() => void reimport()}
                reimporting={committing === 'commit'}
              />
            ) : null}
            <ReceiptLedger view={receipt} batchId={batch.id} />
          </div>
        </div>
        {confirmDialog}
      </div>
    )
  }

  // Ledger mode (SPA-170): steps 2 and 3 are the ledger's own components.
  if (batch.mode === 'ledger' && ledger?.preview)
    return (
      <LedgerPreviewStep
        batch={batch}
        view={ledger.preview}
        uploadHint={uploadHint}
        committing={committing === 'commit'}
        {...(canCommit ? { onCommit: () => commit(false) } : {})}
      />
    )
  if (batch.mode === 'ledger' && ledger?.mapping)
    return (
      <>
        <LedgerMappingStep
          batch={batch}
          view={ledger.mapping}
          objects={objects}
          uploadHint={uploadHint}
          discarding={discarding}
          onDiscard={() => void discard()}
        />
        {confirmDialog}
      </>
    )

  if (preview) {
    return (
      <div className="flex h-full flex-col">
        <PreviewHeader
          counts={preview.counts}
          filename={batch.filename}
          onBack={backToMapping}
          backing={backing}
          committing={committing === 'commit'}
          {...(canCommit ? { onCommit: () => commit(false) } : {})}
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
      <StepStrip
        step={step}
        uploadHint={uploadHint}
        mapHint={mapHint}
        mode={batch.mode}
      />
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
