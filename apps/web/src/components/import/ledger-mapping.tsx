import { useRouter } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import {
  INSTRUMENTS,
  INSTRUMENT_LABELS,
  LEDGER_CURRENCIES,
  LEDGER_DATE_FIELDS,
  LEDGER_FIELD_LABELS,
  LEDGER_GROUP_LABELS,
  LEDGER_LINES,
  ledgerColumnsOf,
  ledgerDecisionsOf,
  ledgerReadout,
  lineBecomes,
  lineColumns,
  sharedDateOrder,
} from '@spaces/core/import/ledger'
import { columnName } from '@spaces/core/import/mapping'
import {
  DefineRow,
  ImportHeader,
  SheetTabs,
  StepStrip,
  refuseContinue,
} from '#/components/import/import-wizard'
import { Checkbox } from '#/components/ui/checkbox'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { Input } from '#/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Segmented } from '#/components/ui/segmented'
import { Select } from '#/components/ui/select'
import {
  defineImportBatch,
  mapLedgerField,
  planLedgerImport,
  selectImportSheet,
  setLedgerDecision,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import type {
  InstrumentValue,
  LedgerDecision,
  LedgerField,
  LedgerGroup,
  LedgerInstrumentResolution,
  LedgerLine,
} from '@spaces/core/import/ledger'
import type { Mapping } from '@spaces/core/import/mapping'
import type {
  ImportMode,
  ImportObject,
} from '#/components/import/import-wizard'
import type { LedgerMappingView } from '#/lib/import/ledger'

/**
 * The ledger mapping step (SPA-170, import-8): the sheet's columns onto
 * **event fields**, not attributes. Left, the target table — caps groups
 * (company, round, our cheque, current mark, proceeds), each with one mono
 * hint, and 36px lines of field · picker · what row 1 becomes. Right, the
 * bone decisions panel: what the plan cannot decide alone — an ambiguous
 * instrument value, a mark with no date, a row naming no currency, a date
 * that reads two ways. The group hints and the panel's one-line notes are
 * the only commentary (design contract §1).
 *
 * Copied, not designed: the page header and step strip are the wizard's,
 * the line picker is `mapping-grid.tsx`'s trigger over the shipped Popover
 * with one `Select` per field, the panel is the bone strip anatomy.
 */

type Batch = {
  id: string
  filename: string
  sizeBytes: number
  sheet: string
  sheets: Array<string>
  header: Array<string> | null
  mode: ImportMode
  targetObjectId: string | null
  status: string
  rowCount: number
  preview: Array<{ rowNum: number; cells: Array<string> }>
}

/** What the panel decides — a row's own instrument is the preview's. */
type PanelDecision = Exclude<LedgerDecision, { kind: 'rowInstrument' }>

/** The sheet's width, as the mapping is fitted to it. */
const widthOf = (view: LedgerMappingView) => view.mapping.length

// ---------------------------------------------------------------------------
// What needs a decision
// ---------------------------------------------------------------------------

type Open = {
  instrument: boolean
  marksAsOf: boolean
  currency: boolean
  dateOrder: boolean
}

function openOf(view: LedgerMappingView): Open {
  const columns = ledgerColumnsOf(view.mapping)
  const decisions = ledgerDecisionsOf(columns)
  const s = view.summary
  return {
    instrument:
      columns.instrument === undefined ||
      s.instruments.some((v) => v.resolution === null),
    marksAsOf: s.marksWithoutDate > 0 && decisions.marksAsOf === null,
    currency: s.rowsWithoutCurrency > 0 && decisions.currency === null,
    dateOrder:
      s.dates.ambiguous > 0 &&
      LEDGER_DATE_FIELDS.some(
        (f) => columns[f] !== undefined && columns[f].dateOrder === undefined,
      ),
  }
}

function lineNeeds(line: LedgerLine, open: Open, mapping: Mapping): boolean {
  const columns = ledgerColumnsOf(mapping)
  const has = (f: LedgerField) => line.fields.includes(f)
  if (has('instrument') && open.instrument) return true
  if (has('markValue') && open.marksAsOf) return true
  if (has('amount') && open.currency) return true
  return (
    open.dateOrder &&
    line.fields.some(
      (f) =>
        LEDGER_DATE_FIELDS.includes(f) &&
        columns[f] !== undefined &&
        columns[f].dateOrder === undefined,
    )
  )
}

function groupHint(
  group: LedgerGroup,
  view: LedgerMappingView,
  rowCount: number,
): string {
  const n = view.summary.groups[group]
  const of = `${n.toLocaleString('en-US')} of ${rowCount.toLocaleString('en-US')}`
  switch (group) {
    case 'company':
      return "the holding's owner"
    case 'cheque':
      return `required · ${of}`
    case 'round':
    case 'mark':
    case 'proceeds':
      return `optional · ${of}`
  }
}

// ---------------------------------------------------------------------------
// A line's picker
// ---------------------------------------------------------------------------

function LinePicker({
  line,
  view,
  header,
  needs,
  disabled,
  onMap,
}: {
  line: LedgerLine
  view: LedgerMappingView
  header: Array<string> | null
  needs: boolean
  disabled: boolean
  onMap: (field: LedgerField, column: number | null) => void
}) {
  const columns = ledgerColumnsOf(view.mapping)
  const letters = lineColumns(line, view.mapping)
  const items = [
    { value: 'none', label: 'Not in this sheet' },
    ...Array.from({ length: widthOf(view) }, (_, i) => ({
      value: String(i),
      label: columnName(i, header),
    })),
  ]
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={`Sheet column for ${line.label}`}
        className={cn(
          'focus-ring-inset flex h-7 w-55 shrink-0 items-center gap-1.5 rounded-md border px-2 text-left transition-colors duration-150 ease-out-quart disabled:opacity-50',
          letters === null
            ? 'border-dashed border-rule bg-bone text-graphite'
            : needs
              ? 'border-warning bg-paper'
              : 'border-hairline bg-paper',
        )}
      >
        <span className="min-w-0 flex-1 truncate mono text-micro">
          {letters ?? 'not in this sheet'}
        </span>
        <ChevronDown
          aria-hidden
          className="size-3 shrink-0 text-graphite"
          strokeWidth={2}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-80 flex-col p-0">
        {line.fields.map((field) => {
          const held = columns[field]
          return (
            <div
              key={field}
              className="flex h-11 items-center gap-3 border-b border-rule px-3 last:border-b-0"
            >
              <span className="w-28 shrink-0 text-ui">
                {LEDGER_FIELD_LABELS[field]}
              </span>
              <Select
                aria-label={`Column for ${LEDGER_FIELD_LABELS[field]}`}
                width="content"
                className="min-w-0 flex-1"
                value={held ? String(held.column) : 'none'}
                items={items}
                disabled={disabled}
                onChange={(v) => onMap(field, v === 'none' ? null : Number(v))}
              />
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// The target table
// ---------------------------------------------------------------------------

function TargetTable({
  view,
  batch,
  open,
  disabled,
  onMap,
}: {
  view: LedgerMappingView
  batch: Batch
  open: Open
  disabled: boolean
  onMap: (field: LedgerField, column: number | null) => void
}) {
  const first = batch.preview.at(0)?.cells ?? []
  const groups = [...new Set(LEDGER_LINES.map((l) => l.group))]
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Event fields">
      <div className="flex h-8 items-center gap-3 border-b border-hairline px-2 label-caps text-graphite">
        <span className="w-52 shrink-0">Event field</span>
        <span className="w-55 shrink-0">Sheet column</span>
        <span className="min-w-0 flex-1">Row 1 becomes</span>
      </div>
      {groups.map((group) => (
        <div key={group} className="flex flex-col">
          <div className="flex h-9 items-end gap-3 border-b border-rule px-2 pb-1.5">
            <span className="label-caps text-foreground">
              {LEDGER_GROUP_LABELS[group]}
            </span>
            <span className="tabular mono text-micro text-graphite">
              {groupHint(group, view, batch.rowCount)}
            </span>
          </div>
          {LEDGER_LINES.filter((l) => l.group === group).map((line) => {
            const needs = lineNeeds(line, open, view.mapping)
            const becomes = lineBecomes(line, first, view.mapping)
            return (
              <div
                key={line.label}
                className={cn(
                  'flex h-row items-center gap-3 border-b border-rule px-2',
                  needs && 'bg-[var(--badge-amber)]',
                )}
              >
                <span className="w-52 shrink-0 truncate text-ui">
                  {line.label}
                </span>
                <LinePicker
                  line={line}
                  view={view}
                  header={batch.header}
                  needs={needs}
                  disabled={disabled}
                  onMap={onMap}
                />
                <span
                  className="min-w-0 flex-1 truncate text-ui"
                  title={becomes}
                >
                  {becomes === '' ? (
                    <span className="text-graphite">—</span>
                  ) : (
                    becomes
                  )}
                </span>
              </div>
            )
          })}
        </div>
      ))}
    </section>
  )
}

// ---------------------------------------------------------------------------
// The decisions panel
// ---------------------------------------------------------------------------

function PanelSection({
  label,
  note,
  children,
}: {
  label: string
  note: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-rule px-4 py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label-caps text-foreground">{label}</span>
        <span className="tabular mono text-micro text-graphite">{note}</span>
      </div>
      {children}
    </div>
  )
}

const RESOLUTION_ITEMS: Array<{
  value: LedgerInstrumentResolution
  label: string
}> = [
  ...INSTRUMENTS.map((i) => ({ value: i, label: INSTRUMENT_LABELS[i] })),
  { value: 'per_row', label: 'Decide per row' },
]

function InstrumentRow({
  value,
  disabled,
  onResolve,
}: {
  value: InstrumentValue
  disabled: boolean
  onResolve: (resolution: LedgerInstrumentResolution) => void
}) {
  const shown = value.raw === '' ? 'Blank' : `"${value.raw}"`
  const safe = value.candidates.length === 2 && !value.auto
  const rows = `· ${value.rows.toLocaleString('en-US')} row${value.rows === 1 ? '' : 's'}`
  if (safe)
    return (
      <div className="flex flex-col gap-1.5">
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'text-ui',
              value.resolution === null && 'text-warning',
            )}
          >
            {shown}
          </span>
          <span className="tabular mono text-micro text-graphite">{rows}</span>
        </span>
        <Segmented
          size="sm"
          label={`Instrument for ${shown}`}
          disabled={disabled}
          value={value.resolution ?? 'none'}
          options={[
            { id: 'safe_post_money', label: 'Post-money SAFE' },
            { id: 'safe_pre_money', label: 'Pre-money SAFE' },
            { id: 'per_row', label: 'Decide per row' },
          ]}
          onChange={(id) => {
            if (id !== 'none') onResolve(id)
          }}
        />
      </div>
    )
  return (
    <div className="flex items-center gap-3">
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span
          className={cn(
            'truncate text-ui',
            value.resolution === null && 'text-warning',
          )}
        >
          {shown}
        </span>
        <span className="tabular shrink-0 mono text-micro text-graphite">
          {rows}
        </span>
      </span>
      <Select
        aria-label={`Instrument for ${shown}`}
        width="content"
        placeholder="Choose"
        className={cn(
          'h-7 w-44 shrink-0',
          value.resolution === null && 'border-warning',
        )}
        value={value.resolution ?? ''}
        items={RESOLUTION_ITEMS}
        disabled={disabled}
        onChange={onResolve}
      />
    </div>
  )
}

function DecisionsPanel({
  view,
  open,
  disabled,
  decide,
  onAsOfChange,
  onAsOfBlur,
}: {
  view: LedgerMappingView
  open: Open
  disabled: boolean
  decide: (decision: PanelDecision) => void
  /** The date as typed — a native date input reports partial years too. */
  onAsOfChange: (value: string) => void
  onAsOfBlur: () => void
}) {
  const columns = ledgerColumnsOf(view.mapping)
  const decisions = ledgerDecisionsOf(columns)
  const s = view.summary
  const [asOf, setAsOf] = useState(decisions.marksAsOf ?? '')
  useEffect(() => setAsOf(decisions.marksAsOf ?? ''), [decisions.marksAsOf])
  const c = view.companies
  const order = sharedDateOrder(view.mapping)
  return (
    <aside
      aria-label="Decisions"
      className="flex w-95 shrink-0 flex-col border border-rule bg-bone"
    >
      <div className="flex h-10 items-center justify-between border-b border-hairline px-4">
        <span className="label-caps text-foreground">Decisions</span>
        <span
          className={cn(
            'tabular mono text-micro',
            s.open > 0 ? 'text-warning' : 'text-graphite',
          )}
        >
          {s.open} open
        </span>
      </div>
      {columns.company ? (
        <PanelSection label="Companies" note={`${c.found} of ${c.total} found`}>
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={columns.company.createMissing === true}
              disabled={disabled}
              aria-label="Create missing companies"
              onCheckedChange={(next) =>
                decide({ kind: 'createMissing', on: next === true })
              }
            />
            <span className="text-ui">
              Create the {c.missing.toLocaleString('en-US')} missing
            </span>
          </label>
        </PanelSection>
      ) : null}
      {columns.instrument && s.instruments.length > 0 ? (
        <PanelSection
          label="Instrument"
          note={`${s.instruments.length} value${s.instruments.length === 1 ? '' : 's'}`}
        >
          {s.instruments.map((v) => (
            <InstrumentRow
              key={v.key}
              value={v}
              disabled={disabled}
              onResolve={(resolution) =>
                decide({ kind: 'instrument', value: v.key, resolution })
              }
            />
          ))}
        </PanelSection>
      ) : null}
      {s.marksWithoutDate > 0 && columns.markValue ? (
        <PanelSection
          label="Marks as of"
          note={`${s.marksWithoutDate} mark${s.marksWithoutDate === 1 ? '' : 's'} undated`}
        >
          <Input
            type="date"
            aria-label="Marks as of"
            value={asOf}
            disabled={disabled}
            className={cn('w-44', open.marksAsOf && 'border-warning')}
            onChange={(e) => {
              setAsOf(e.target.value)
              onAsOfChange(e.target.value)
            }}
            onBlur={onAsOfBlur}
          />
        </PanelSection>
      ) : null}
      {s.rowsWithoutCurrency > 0 && columns.amount ? (
        <PanelSection
          label="Currency"
          note={`${s.rowsWithoutCurrency} row${s.rowsWithoutCurrency === 1 ? '' : 's'} name none`}
        >
          <Select
            aria-label="Currency for rows that name none"
            width="content"
            placeholder="Choose"
            className={cn('w-44', open.currency && 'border-warning')}
            value={decisions.currency ?? ''}
            items={LEDGER_CURRENCIES.map((code) => ({
              value: code,
              label: code,
            }))}
            disabled={disabled}
            onChange={(code) => decide({ kind: 'currency', code })}
          />
        </PanelSection>
      ) : null}
      {s.dates.ambiguous > 0 ? (
        <PanelSection
          label="Date order"
          note={`${s.dates.flips} date${s.dates.flips === 1 ? '' : 's'} flip`}
        >
          <Segmented
            size="sm"
            label="Date order"
            disabled={disabled}
            value={order ?? 'none'}
            options={[
              { id: 'dmy', label: 'D/M/Y' },
              { id: 'mdy', label: 'M/D/Y' },
            ]}
            onChange={(id) => {
              if (id !== 'none') decide({ kind: 'dateOrder', order: id })
            }}
          />
        </PanelSection>
      ) : null}
    </aside>
  )
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export function LedgerMappingStep({
  batch,
  view,
  objects,
  uploadHint,
  discarding,
  onDiscard,
}: {
  batch: Batch
  view: LedgerMappingView
  objects: Array<ImportObject>
  uploadHint: string
  discarding: boolean
  onDiscard: () => void
}) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const staged = batch.status === 'staged'
  const open = openOf(view)

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

  async function keepsMapping(what: string): Promise<boolean> {
    return confirm({
      title: `Change the ${what}?`,
      body: 'The event mapping starts over from the header.',
      action: `Change ${what}`,
    })
  }

  function onMap(field: LedgerField, column: number | null) {
    void write(async () => {
      const out = await mapLedgerField({
        data: { batchId: batch.id, field, column },
      })
      for (const r of out.replaced)
        if (r.previous.target === 'ledger')
          toast(
            `${LEDGER_FIELD_LABELS[r.previous.field]} is no longer in the sheet`,
          )
    })
  }

  function decide(decision: PanelDecision) {
    void write(() =>
      setLedgerDecision({ data: { batchId: batch.id, decision } }),
    )
  }

  // "Marks as of" is written on blur, not on change: Chrome reports every
  // partial year (`0002`, `0020`, …) as a change. Blur alone lost the date
  // when Continue's plan call raced the write (found live, SPA-170), so the
  // typed value waits in a ref and Continue flushes it before it plans; the
  // in-flight write is chained so the plan never overtakes it.
  const pendingAsOf = useRef<string | null>(null)
  const asOfFlight = useRef<Promise<void>>(Promise.resolve())
  const storedAsOf = ledgerDecisionsOf(ledgerColumnsOf(view.mapping)).marksAsOf

  function flushAsOf(): Promise<void> {
    const typed = pendingAsOf.current
    if (typed !== null) {
      pendingAsOf.current = null
      const date = typed === '' ? null : typed
      if (date !== storedAsOf) {
        const next = asOfFlight.current.then(() =>
          setLedgerDecision({
            data: { batchId: batch.id, decision: { kind: 'marksAsOf', date } },
          }).then(() => undefined),
        )
        asOfFlight.current = next.catch(() => undefined)
        return next
      }
    }
    return asOfFlight.current
  }

  const canContinue = staged && !busy

  function onContinue() {
    if (refuseContinue(view.problems)) return
    setContinuing(true)
    void write(async () => {
      await flushAsOf()
      await planLedgerImport({ data: { batchId: batch.id } })
    }).finally(() => setContinuing(false))
  }

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

  const mapped = view.mapping.filter((t) => t.target === 'ledger').length
  const mapHint =
    view.problems.length === 0
      ? `${mapped} of ${view.mapping.length} mapped`
      : null

  return (
    <div className="flex h-full flex-col">
      <ImportHeader
        mode="ledger"
        title="Each row becomes dated events, never a balance."
        readout={
          <span className="tabular">
            {[
              batch.filename,
              `sheet ${batch.sheet}`,
              `${batch.rowCount.toLocaleString('en-US')} rows`,
              ...ledgerReadout(view.counts),
            ].join(' · ')}
          </span>
        }
        discarding={discarding}
        continuing={continuing}
        {...(staged ? { onDiscard } : {})}
        {...(canContinue ? { onContinue } : {})}
      />
      <StepStrip
        step={1}
        mode="ledger"
        uploadHint={uploadHint}
        mapHint={mapHint}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-8 py-6">
        <DefineRow
          objects={objects}
          mode="ledger"
          targetObjectId={null}
          disabled={busy || !staged}
          onChange={(mode, targetObjectId) => {
            if (mode === 'ledger') return
            void keepsMapping('mode').then((ok) => {
              if (ok)
                void write(() =>
                  defineImportBatch({
                    data: { batchId: batch.id, mode, targetObjectId },
                  }),
                )
            })
          }}
        />
        <SheetTabs
          sheets={batch.sheets}
          current={batch.sheet}
          disabled={busy || !staged}
          onSelect={(sheet) =>
            void keepsMapping('sheet').then((ok) => {
              if (ok)
                void write(() =>
                  selectImportSheet({ data: { batchId: batch.id, sheet } }),
                )
            })
          }
        />
        <div className="flex items-start gap-6">
          <TargetTable
            view={view}
            batch={batch}
            open={open}
            disabled={busy || !staged}
            onMap={onMap}
          />
          <DecisionsPanel
            view={view}
            open={open}
            disabled={busy || !staged}
            decide={decide}
            onAsOfChange={(value) => {
              pendingAsOf.current = value
            }}
            // Not through `write`: its `busy` would disable Continue under
            // the click that blurred the field, and Continue awaits the
            // in-flight write itself.
            onAsOfBlur={() => {
              void flushAsOf()
                .then(() => router.invalidate())
                .catch((err: unknown) =>
                  toast.error(
                    err instanceof Error ? err.message : 'Could not save',
                  ),
                )
            }}
          />
        </div>
      </div>
      {confirmDialog}
    </div>
  )
}
