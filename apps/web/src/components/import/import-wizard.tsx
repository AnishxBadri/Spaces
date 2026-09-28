import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DitherBlock } from '#/components/dither'
import { KeyHint, PageHeader } from '#/components/page-header'
import { Button } from '#/components/ui/button'
import { Select } from '#/components/ui/select'
import { columnLetter } from '@spaces/core/import/mapping'
import { cn } from '#/lib/utils'

/**
 * The import wizard's chrome (SPA-164, import-2): the page header, the
 * four-step strip, the drop zone, the define row (object + mode), the sheet
 * tabs and the preview grid. Steps 1 and 2 are live (the mapping grid is
 * `mapping-grid.tsx`, SPA-165); the strip draws the other two inert so the
 * shape of the wizard is visible from the start.
 *
 * Copied, not designed: the header is `PageHeader`, the drop zone is the P5
 * `EmptyState` anatomy with a dashed rule, the grid keeps `RecordTable`'s
 * 36px rows on rules and its caps mono head.
 */

export type ImportMode = 'records' | 'ledger'

export type ImportObject = { id: string; plural: string }

export type PreviousImport = {
  id: string
  filename: string
  status: string
  rowCount: number
  written: number
  createdAt: string
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function ImportHeader({
  mode,
  title,
  readout,
  onDiscard,
  discarding = false,
  onContinue,
  continuing = false,
}: {
  mode: ImportMode
  title: string
  readout?: ReactNode
  /** Absent before a file is staged — there is nothing to discard. */
  onDiscard?: () => void
  discarding?: boolean
  /** Absent until the step can be left — no object chosen, no file staged. */
  onContinue?: () => void
  continuing?: boolean
}) {
  return (
    <PageHeader
      eyebrow={`Import · ${mode === 'ledger' ? 'Ledger' : 'Records'}`}
      title={title}
      description={readout}
      action={
        <>
          <Button
            variant="outline"
            disabled={!onDiscard}
            pending={discarding}
            onClick={onDiscard}
          >
            {discarding ? 'Discarding…' : 'Discard'}
          </Button>
          <Button
            disabled={!onContinue}
            pending={continuing}
            onClick={onContinue}
          >
            Continue <KeyHint>⌘↵</KeyHint>
          </Button>
        </>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Step strip
// ---------------------------------------------------------------------------

const STEPS = ['Upload', 'Map columns', 'Preview', 'Commit'] as const

/**
 * Four cells on rules; the current one carries the 2px ink foot. `step` is
 * read off the batch by the caller (a mapping on the row is step 2), never
 * kept in component state, so a reload lands where the operator left.
 */
export function StepStrip({
  uploadHint,
  step = 0,
  mapHint = null,
}: {
  uploadHint: string | null
  step?: 0 | 1
  /** Step 2's readout once its mapping would advance — `7 of 11 mapped`. */
  mapHint?: string | null
}) {
  return (
    <nav
      aria-label="Import steps"
      className="flex h-10 shrink-0 border-b border-hairline"
    >
      {STEPS.map((label, i) => {
        const current = i === step
        const hint = i === 0 ? uploadHint : i === 1 ? mapHint : null
        const done = hint !== null
        return (
          <div
            key={label}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2 border-r border-rule px-4 text-ui last:border-r-0',
              i === 0 && 'pl-8',
              current
                ? 'border-b-2 border-b-foreground font-medium text-foreground'
                : 'text-graphite',
            )}
          >
            {done ? (
              <Check
                className="size-3.5 shrink-0 text-success"
                strokeWidth={2}
                aria-label="done"
              />
            ) : null}
            <span className="tabular mono text-label">{i + 1}</span>
            <span className="truncate">{label}</span>
            {done ? (
              <span className="truncate mono text-micro font-normal text-graphite">
                {hint}
              </span>
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Drop zone
// ---------------------------------------------------------------------------

/** P5 anatomy on a dashed rule: dither, one serif line, one sans line. */
export function DropZone({
  onFile,
  busy,
  error,
}: {
  onFile: (file: File) => void
  busy: boolean
  error: string | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files.item(0)
          if (file) onFile(file)
        }}
        className={cn(
          'focus-ring flex min-h-80 w-full flex-col items-center justify-center gap-4 border border-dashed text-center transition-colors duration-150 ease-out-quart disabled:opacity-50',
          dragging
            ? 'border-primary bg-selected'
            : 'border-rule bg-paper hover:bg-bone',
        )}
      >
        <DitherBlock />
        <span className="font-serif text-xl leading-6 font-semibold">
          {busy
            ? 'Reading the spreadsheet…'
            : dragging
              ? 'Release to stage it'
              : 'Drop a spreadsheet'}
        </span>
        <span className="max-w-80 text-ui leading-5 text-graphite">
          A CSV, TSV or Excel workbook — nothing is written until you commit.
        </span>
        <span className="mono text-micro text-graphite">
          csv · tsv · xlsx · 20,000 rows
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only"
        aria-label="Choose a spreadsheet"
        onChange={(e) => {
          const file = e.target.files?.item(0)
          if (file) onFile(file)
          e.target.value = ''
        }}
      />
      {error ? (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// An earlier import of the same bytes
// ---------------------------------------------------------------------------

/** The section's one commentary line: when, what state, what it wrote. */
export function previousImportLine(p: PreviousImport): string {
  return `imported ${p.createdAt.slice(0, 10)} · ${p.filename} · ${p.status} · ${p.rowCount.toLocaleString('en-US')} rows · ${p.written.toLocaleString('en-US')} written`
}

export function PreviousImportNotice({
  previous,
  action,
}: {
  previous: PreviousImport
  action?: ReactNode
}) {
  return (
    <section className="flex flex-wrap items-center gap-3 border border-rule bg-bone px-4 py-3">
      <span className="label-caps text-foreground">Imported before</span>
      <span className="mono text-label text-graphite">
        {previousImportLine(previous)}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link to="/import/$batchId" params={{ batchId: previous.id }}>
            Open that import
          </Link>
        </Button>
        {action}
      </span>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Define: object + mode
// ---------------------------------------------------------------------------

export function DefineRow({
  objects,
  mode,
  targetObjectId,
  onChange,
  disabled,
}: {
  objects: Array<ImportObject>
  mode: ImportMode
  targetObjectId: string | null
  onChange: (mode: ImportMode, targetObjectId: string | null) => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="label-caps text-graphite">Into</span>
      <div
        role="group"
        aria-label="Import mode"
        className="flex items-center gap-1"
      >
        {(['records', 'ledger'] as const).map((m) => (
          <Button
            key={m}
            variant="outline"
            size="sm"
            aria-pressed={mode === m}
            disabled={disabled}
            onClick={() => onChange(m, m === 'ledger' ? null : targetObjectId)}
            className={cn(mode === m && 'bg-selected hover:bg-selected')}
          >
            {m === 'records' ? 'Records' : 'Ledger'}
          </Button>
        ))}
      </div>
      {mode === 'records' ? (
        <Select
          aria-label="Object"
          width="content"
          className="w-56"
          placeholder="Choose an object"
          value={targetObjectId ?? ''}
          disabled={disabled}
          items={objects.map((o) => ({ value: o.id, label: o.plural }))}
          onChange={(id) => onChange('records', id)}
        />
      ) : (
        <span className="text-ui text-graphite">Portfolio</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sheet tabs
// ---------------------------------------------------------------------------

export function SheetTabs({
  sheets,
  current,
  onSelect,
  disabled,
}: {
  sheets: Array<string>
  current: string
  onSelect: (sheet: string) => void
  disabled: boolean
}) {
  if (sheets.length < 2) return null
  return (
    <div
      role="tablist"
      aria-label="Sheets"
      className="flex items-end gap-0 border-b border-rule"
    >
      {sheets.map((sheet) => (
        <button
          key={sheet}
          type="button"
          role="tab"
          aria-selected={sheet === current}
          disabled={disabled}
          onClick={() => onSelect(sheet)}
          className={cn(
            'focus-ring-inset -mb-px h-8 border-b-2 px-3 label-caps transition-colors duration-150 ease-out-quart disabled:opacity-50',
            sheet === current
              ? 'border-b-foreground text-foreground'
              : 'border-b-transparent text-graphite hover:bg-bone',
          )}
        >
          {sheet}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preview grid
// ---------------------------------------------------------------------------

/** A, B, … Z, AA — the head when the sheet has no header row. */
export { columnLetter }

export function PreviewGrid({
  header,
  columnCount,
  rows,
  rowCount,
}: {
  header: Array<string> | null
  columnCount: number
  rows: Array<{ rowNum: number; cells: Array<string> }>
  rowCount: number
}) {
  const head =
    header ?? Array.from({ length: columnCount }, (_, i) => columnLetter(i))
  return (
    <section className="flex min-h-0 flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <span className="label-caps text-foreground">Rows</span>
        <span className="tabular mono text-label text-graphite">
          first {rows.length} of {rowCount.toLocaleString('en-US')}
        </span>
      </div>
      <div className="isolate min-h-0 overflow-auto border border-rule">
        <table className="border-collapse text-ui" aria-label="Sheet preview">
          <thead className="sticky top-0 z-10 bg-paper">
            <tr className="h-8 border-b border-hairline">
              <th className="w-10 min-w-10 border-r border-rule" />
              {head.map((cell, i) => (
                <th
                  key={i}
                  scope="col"
                  className="max-w-60 min-w-28 truncate border-r border-rule px-2 text-left align-middle label-caps text-graphite last:border-r-0"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rowNum} className="h-row border-b border-rule">
                <td className="tabular w-10 min-w-10 border-r border-rule px-2 text-right mono text-micro text-graphite">
                  {row.rowNum}
                </td>
                {row.cells.map((cell, i) => (
                  <td
                    key={i}
                    title={cell}
                    className="max-w-60 truncate border-r border-rule px-2 align-middle whitespace-nowrap last:border-r-0"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
