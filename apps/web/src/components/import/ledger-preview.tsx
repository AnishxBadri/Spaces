import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { INSTRUMENT_LABELS, ledgerSentence } from '@spaces/core/import/ledger'
import { NoLandTail, StepStrip } from '#/components/import/import-wizard'
import { KeyHint, PageHeader, ReadoutStrip } from '#/components/page-header'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Select } from '#/components/ui/select'
import { decideLedgerRow, reopenImportMapping } from '#/lib/server-fns'
import type {
  LedgerCompanyReport,
  LedgerCounts,
  LedgerInstrument,
} from '@spaces/core/import/ledger'
import type { LedgerFailedRow, LedgerPreviewView } from '#/lib/import/ledger'

/**
 * The ledger preview (SPA-170, import-8): the dry run of a ledger batch,
 * drawn from the stored plans in SPA-167's frame — the verdict sentence as
 * the title, the readout strip, the ledger rows — except that **a row is a
 * company**, and its what-lands lane is the events it would write, in date
 * order: `round Seed 2023-03-15 · investment $50,000 priced · mark $120,000
 * 2025-12-31`. Rows that will not land follow, each with its reason, and a
 * SAFE decided per row carries its choice in the decision lane; any other
 * stop ends on one token — `decide in mapping ›` back to step 2, or `fix in
 * the sheet` (SPA-173). Commit
 * (SPA-171) enqueues the same `import.commit` job a records batch does, and
 * the page turns into its receipt.
 */

export function ledgerStripCells(counts: LedgerCounts) {
  return [
    { label: 'Holdings', value: counts.holdings },
    { label: 'Rounds', value: counts.rounds },
    { label: 'Investments', value: counts.investments },
    { label: 'Marks', value: counts.marks },
    {
      label: 'Need a decision',
      value: counts.needDecision,
      tone: 'warn' as const,
    },
  ]
}

/** A company's what-lands lane: its events in date order, joined. */
export function eventsText(company: LedgerCompanyReport): string {
  return company.events.map((e) => e.text).join(' · ')
}

const HEAD = ['Rows', 'Company', 'Verdict', 'Holding', 'What lands']

export function CompanyRow({ company }: { company: LedgerCompanyReport }) {
  const text = eventsText(company)
  return (
    <li className="flex h-10 items-center gap-3 border-b border-rule px-2">
      <span className="tabular w-16 shrink-0 truncate text-right mono text-micro text-graphite">
        {company.rows.join(', ')}
      </span>
      <span className="w-50 shrink-0 truncate text-ui" title={company.name}>
        {company.name}
      </span>
      <span className="flex w-22 shrink-0">
        <Badge
          option={{ color: company.verdict === 'attach' ? 'blue' : 'emerald' }}
          index={0}
        >
          {company.verdict}
        </Badge>
      </span>
      <span className="w-28 shrink-0 truncate mono text-micro text-graphite">
        {company.holding === 'birth' ? 'new holding' : 'held'}
      </span>
      <span
        className="min-w-0 flex-1 truncate mono text-micro text-graphite"
        title={text}
      >
        {text}
      </span>
    </li>
  )
}

export function FailedRow({
  row,
  disabled,
  onDecide,
  onMapping,
}: {
  row: LedgerFailedRow
  disabled: boolean
  onDecide: (rowNum: number, instrument: LedgerInstrument) => void
  /** Back to step 2, where a decision stop is fixed. */
  onMapping: () => void
}) {
  return (
    <li className="flex h-10 items-center gap-3 border-b border-rule bg-[var(--badge-rose)] px-2">
      <span className="tabular w-16 shrink-0 text-right mono text-micro text-graphite">
        {row.rowNum}
      </span>
      <span className="w-50 shrink-0 truncate text-ui" title={row.name ?? ''}>
        {row.name ?? <span className="text-graphite">—</span>}
      </span>
      <span className="flex w-22 shrink-0">
        <Badge option={{ color: 'rose' }} index={0}>
          no land
        </Badge>
      </span>
      <span
        className="min-w-0 flex-1 truncate text-ui text-graphite"
        title={row.why}
      >
        {row.why}
      </span>
      {row.perRow ? (
        <Select
          aria-label={`Instrument for row ${row.rowNum}`}
          width="content"
          placeholder="Choose"
          inset
          className="h-7 w-44 shrink-0 border-warning"
          value=""
          disabled={disabled}
          items={row.perRow.candidates.map((i) => ({
            value: i,
            label: INSTRUMENT_LABELS[i],
          }))}
          onChange={(i) => onDecide(row.rowNum, i)}
        />
      ) : (
        <span className="w-44 shrink-0 truncate text-right mono text-micro">
          <NoLandTail
            stop={row.stop}
            onMapping={onMapping}
            disabled={disabled}
          />
        </span>
      )}
    </li>
  )
}

export function LedgerPreviewStep({
  batch,
  view,
  uploadHint,
  onCommit,
  committing = false,
}: {
  batch: { id: string; filename: string }
  view: LedgerPreviewView
  uploadHint: string
  /** Armed once a row lands (SPA-171); the page becomes the receipt. */
  onCommit?: () => void
  committing?: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [backing, setBacking] = useState(false)
  const counts = view.counts

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

  function back() {
    setBacking(true)
    void write(() =>
      reopenImportMapping({ data: { batchId: batch.id } }),
    ).finally(() => setBacking(false))
  }

  function decide(rowNum: number, instrument: LedgerInstrument) {
    void write(() =>
      decideLedgerRow({ data: { batchId: batch.id, rowNum, instrument } }),
    )
  }

  const landing = counts.total - counts.noLand
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Import · Ledger"
        title={ledgerSentence(counts)}
        description={
          <span className="tabular">
            {batch.filename} · {counts.total.toLocaleString('en-US')} rows ·
            nothing written yet
          </span>
        }
        action={
          <>
            <Button variant="outline" pending={backing} onClick={back}>
              Back to mapping
            </Button>
            <Button
              disabled={!onCommit || landing === 0 || busy}
              pending={committing}
              onClick={onCommit}
            >
              Commit {landing.toLocaleString('en-US')} rows{' '}
              <KeyHint>⌘↵</KeyHint>
            </Button>
          </>
        }
      />
      <StepStrip
        step={2}
        mode="ledger"
        uploadHint={uploadHint}
        mapHint="mapped"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto pb-6">
        <ReadoutStrip
          className="border-t border-t-hairline border-b-rule"
          cells={ledgerStripCells(counts)}
        />
        <section className="flex flex-col px-8">
          <div className="flex h-8 items-center gap-3 border-b border-hairline px-2 label-caps text-graphite">
            <span className="w-16 shrink-0 text-right">{HEAD[0]}</span>
            <span className="w-50 shrink-0">{HEAD[1]}</span>
            <span className="w-22 shrink-0">{HEAD[2]}</span>
            <span className="w-28 shrink-0">{HEAD[3]}</span>
            <span className="min-w-0 flex-1">{HEAD[4]}</span>
          </div>
          <ol aria-label="Planned events by company">
            {view.companies.map((c) => (
              <CompanyRow key={c.company} company={c} />
            ))}
            {view.failed.map((row) => (
              <FailedRow
                key={row.rowNum}
                row={row}
                disabled={busy || backing}
                onDecide={decide}
                onMapping={back}
              />
            ))}
          </ol>
          {view.moreCompanies > 0 ? (
            <p className="tabular pt-3 mono text-micro text-graphite">
              + {view.moreCompanies.toLocaleString('en-US')} more companies
            </p>
          ) : null}
        </section>
      </div>
    </div>
  )
}
