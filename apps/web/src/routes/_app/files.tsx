import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { Layers, Upload } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { DocumentPreview } from '#/components/document-preview'
import {
  GoneMarker,
  OpenInSourceButton,
  OpenSourceButton,
} from '#/components/document-source'
import { DocumentTile } from '#/components/document-tile'
import { KIND_ICONS } from '#/components/editor/mention'
import { EmptyRow } from '#/components/ledger-section'
import { PageHeader } from '#/components/page-header'
import { Button } from '#/components/ui/button'
import { RecordTable, TableToolbar } from '#/components/table/record-table'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { formatBytes } from '@spaces/core/documents'
import { formatDay, formatSince } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { DOCUMENT_EXTRACTION_LABELS } from '#/lib/documents/registry'
import { recordPath } from '#/lib/record-path'
import {
  countShelfDocuments,
  listDocuments,
  reExtractDocument,
} from '#/lib/server-fns'
import { openUploadDialog } from '#/lib/upload-dialog-store'
import { filesSearch } from '#/lib/documents/to-files'

/**
 * `/files` — the fund's files as a set. The page is Files; the rows are
 * `document`s, and every code name keeps that word.
 *
 * This is **a shelf**: a list of things with no
 * object row behind them. So its columns are hand-declared with
 * `createColumnHelper` over `RecordTable` like `/portfolio`, and it has **no
 * `ViewBar`**: saved views address objects, and a shelf is not one. Its one
 * filter is `All · Unfiled`, as tabs on the bar with both counts, plus the
 * text box.
 *
 * A row opens the preview rather than navigating: a document has no page, by
 * decision — inspection, not a destination. The filename is a real button
 * inside the sticky cell so the
 * keyboard reaches it, exactly where `/portfolio` puts its link. A row ends
 * on its exception lane: still extracting, or failed with Re-read.
 *
 * `?filed=unfiled` is the unfiled inbox: a filter on the shelf, not a route —
 * a search param, so reload, back/forward and Today's badge land on the same
 * list. The tabs write the param and read it back and hold no state of their
 * own. `/documents` answers one 301 to here with its query intact (`toFiles`).
 * - `loaderDeps` is what re-runs the loader when the param changes — a loader
 *   that ignored it would render the previous filter's rows under the new URL.
 */
export const Route = createFileRoute('/_app/files')({
  validateSearch: filesSearch,
  loaderDeps: ({ search }) => ({ filed: search.filed }),
  loader: async ({ deps }) => {
    const [documents, counts] = await Promise.all([
      listDocuments({ data: { filed: deps.filed } }),
      countShelfDocuments(),
    ])
    return { documents, counts }
  },
  component: DocumentsPage,
})

type DocumentRow = Awaited<ReturnType<typeof listDocuments>>[number]

const col = createColumnHelper<DocumentRow>()
// FROZEN: renaming resets saved column layouts with no recovery path.
const PREFS_KEY = 'dealos.documents-table.v1'

/** The exception lane's width: `Failed` and its Re-read. */
const EXCEPTION_WIDTH = 150

/**
 * How many chips fit a 36px row before the count takes over. Three names plus
 * a `+N` is the most a lane this wide can print without wrapping, and a
 * wrapped chip row is a taller row — which is the one thing a grid of files
 * filed in three places must not do.
 */
const MAX_CHIPS = 3

/** Sortable text for a chip lane: the names, in the order they render. */
function chipSortKey(names: Array<string>): string {
  return names.join(' ').toLowerCase()
}

function DocumentsPage() {
  const { documents, counts } = Route.useLoaderData()
  const { filed } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [globalFilter, setGlobalFilter] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [previewing, setPreviewing] = useState<DocumentRow | null>(null)
  const prefs = useTablePrefs(PREFS_KEY)
  const { today } = useClock()

  const columns = useMemo(() => {
    const defs: Array<ColumnDef<DocumentRow, unknown>> = [
      col.accessor((r) => r.filename, {
        id: 'filename',
        header: 'File',
        size: 260,
        enableHiding: false,
        cell: (info) => {
          const r = info.row.original
          return (
            <div className="flex h-full min-w-0 items-center gap-1.5">
              <button
                type="button"
                // The row click does the same thing; without this, clicking
                // the button fires both handlers for one intent.
                onClick={(e) => {
                  e.stopPropagation()
                  setPreviewing(r)
                }}
                title={`Preview ${r.filename}`}
                className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left font-medium group-hover:underline hover:underline"
              >
                <DocumentTile kind={r.kind} filename={r.filename} />
                <span className="truncate">{r.filename}</span>
              </button>
              {r.externalStatus === 'gone' ? <GoneMarker /> : null}
              {/* Only a row a source linked has somewhere to open: an
                  upload has no external URL, so it gets no action rather
                  than a dead one. A clip's and a capture's `external_url`
                  are null by construction, so the two never meet. */}
              {r.externalUrl === null ? null : (
                <OpenInSourceButton
                  url={r.externalUrl}
                  filename={r.filename}
                  className="row-reveal"
                />
              )}
              {r.url === null ? null : (
                <OpenSourceButton
                  url={r.url}
                  filename={r.filename}
                  className="row-reveal"
                />
              )}
            </div>
          )
        },
      }),
      col.accessor((r) => chipSortKey(r.records.map((x) => x.name)), {
        id: 'records',
        header: 'Filed against',
        size: 180,
        cell: (info) => (
          <ChipLane
            chips={info.row.original.records.map((rec) => ({
              key: rec.id,
              label: rec.name,
              href: recordPath(rec),
              icon: KIND_ICONS[rec.kind],
            }))}
          />
        ),
      }),
      col.accessor((r) => chipSortKey(r.spaces.map((x) => x.name)), {
        id: 'spaces',
        header: 'Space',
        size: 150,
        cell: (info) => (
          <ChipLane
            chips={info.row.original.spaces.map((s) => ({
              key: s.id,
              label: s.name,
              href: `/spaces/${s.id}`,
              icon: Layers,
            }))}
          />
        ),
      }),
      col.accessor((r) => r.uploadedByName ?? '', {
        id: 'addedBy',
        header: 'Added by',
        size: 130,
        cell: (info) => {
          const name = info.row.original.uploadedByName
          return name === null ? (
            <span className="px-1 text-graphite">—</span>
          ) : (
            <span className="block truncate px-1">{name}</span>
          )
        },
      }),
      col.accessor((r) => r.createdAt, {
        id: 'date',
        header: 'Date',
        size: 100,
        meta: { numeric: true },
        cell: (info) => {
          const r = info.row.original
          return (
            // The day, as every list prints a date; the age is the hover.
            // `sinceMs` was measured on the server, so SSR and hydration agree.
            <span
              title={`${formatSince(r.sinceMs)} ago`}
              className="block truncate px-1 numeric mono text-label text-graphite"
            >
              {formatDay(r.createdAt, today)}
            </span>
          )
        },
      }),
      col.accessor((r) => r.sizeBytes ?? -1, {
        id: 'size',
        header: 'Size',
        size: 80,
        meta: { numeric: true },
        cell: (info) => (
          <span className="block px-1 numeric mono text-graphite">
            {formatBytes(info.row.original.sizeBytes)}
          </span>
        ),
      }),
    ]
    return defs
  }, [today])

  const table = useReactTable({
    data: documents,
    columns,
    state: {
      sorting,
      columnVisibility: prefs.columnVisibility,
      columnSizing: prefs.columnSizing,
      globalFilter,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: prefs.setColumnVisibility,
    onColumnSizingChange: prefs.setColumnSizing,
    onGlobalFilterChange: setGlobalFilter,
    // Filename *and* snippet: the extracted text is why a document shelf can
    // answer "the one that mentioned the SAFE cap" at all, and the 200 chars
    // the server sent are what the box reaches into.
    globalFilterFn: (row, _colId, filter) => {
      const needle = String(filter).toLowerCase()
      const r = row.original
      return (
        r.filename.toLowerCase().includes(needle) ||
        (r.snippet?.toLowerCase().includes(needle) ?? false)
      )
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    columnResizeMode: 'onChange',
  })

  const setFiled = (next: 'all' | 'unfiled') =>
    void navigate({ search: (prev) => ({ ...prev, filed: next }) })

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Files"
        action={
          /* The upload door on the shelf that lists what it produces. The
             dialog lives in the app shell; the chassis and ⌘K open it too. */
          <Button onClick={openUploadDialog}>
            <Upload className="size-3.5" strokeWidth={2} />
            Upload
          </Button>
        }
      />
      {counts.all === 0 ? (
        // First run: nothing on the shelf — one row that uploads.
        <div className="px-8 pt-6 pb-8">
          <EmptyRow name="Files" onAdd={openUploadDialog} />
        </div>
      ) : (
        <>
          <TableToolbar
            table={table}
            label="Files by filing"
            tabs={[
              { id: 'all', label: 'All', count: counts.all },
              { id: 'unfiled', label: 'Unfiled', count: counts.unfiled },
            ]}
            value={filed}
            onValueChange={setFiled}
            filter={globalFilter}
            onFilterChange={setGlobalFilter}
            filterPlaceholder="Search files"
            filterLabel="Search files"
          />
          <div className="px-8 pb-8">
            {documents.length === 0 ? (
              // The inbox is clear: good news, one line. `All` is the way back.
              <p className="py-6 font-serif text-body text-graphite">
                Nothing unfiled.
              </p>
            ) : (
              <RecordTable
                table={table}
                label="Files"
                stickyColumnId="filename"
                onRowClick={setPreviewing}
                rowEnd={(r) => <ExceptionLane doc={r} />}
                rowEndWidth={EXCEPTION_WIDTH}
              />
            )}
          </div>
        </>
      )}
      <DocumentPreview
        doc={previewing}
        onOpenChange={(open) => !open && setPreviewing(null)}
      />
    </div>
  )
}

/**
 * A row's exception lane: `Extracting…` while the text is being read,
 * `Failed` with Re-read when it could not be — the reason on hover — and
 * nothing for a file that read cleanly.
 */
function ExceptionLane({ doc }: { doc: DocumentRow }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  if (doc.extractionStatus === 'pending')
    return (
      <span
        data-exception="pending"
        className="block truncate px-1 mono text-label text-graphite"
      >
        {DOCUMENT_EXTRACTION_LABELS.pending}
      </span>
    )
  if (doc.extractionStatus !== 'failed') return null

  async function reRead() {
    setBusy(true)
    try {
      const { queued } = await reExtractDocument({
        data: { documentId: doc.id },
      })
      // Pending either way and re-queueable; a down worker is said, not hidden.
      if (!queued) toast.message('Queued when the worker is back')
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not re-read')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span data-exception="failed" className="flex items-center gap-2 px-1">
      <span
        {...(doc.extractionError === null
          ? {}
          : { title: doc.extractionError })}
        className="mono text-label text-destructive"
      >
        {DOCUMENT_EXTRACTION_LABELS.failed}
      </span>
      <Button
        size="xs"
        variant="outline"
        pending={busy}
        onClick={() => void reRead()}
      >
        Re-read
      </Button>
    </span>
  )
}

type Chip = {
  key: string
  label: string
  /** Null for a kind with no page — it reads as text rather than a dead link. */
  href: string | null
  /** Undefined for a kind with no mark; the chip is then its name alone. */
  icon: LucideIcon | undefined
}

/**
 * Up to three chips, then a mono count of the rest. The count is text, not a
 * control: expanding it would either grow the row or open a popover, and the
 * filing popover on the Files tab is already where a document's full filing
 * is edited.
 *
 * `overflow-hidden` with no wrap is what holds the 36px row. A document filed
 * in three places is a lane of three chips that truncate; a document filed in
 * nine is three chips and `+6`, and both are the same height.
 */
function ChipLane({ chips }: { chips: Array<Chip> }) {
  if (chips.length === 0) return <span className="px-1 text-graphite">—</span>
  const shown = chips.slice(0, MAX_CHIPS)
  const rest = chips.length - shown.length

  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden px-1">
      {shown.map((chip) => {
        const Icon = chip.icon
        const inside = (
          <>
            {Icon ? (
              <Icon className="size-2.5 shrink-0" strokeWidth={1.75} />
            ) : null}
            <span className="truncate">{chip.label}</span>
          </>
        )
        return (
          <span
            key={chip.key}
            title={chip.label}
            className="flex h-5 min-w-0 shrink items-center gap-1 border border-rule bg-paper px-1.5 text-label font-medium"
          >
            {chip.href ? (
              <Link
                to={chip.href}
                // The row opens the preview; a chip is a different intent and
                // must not do both.
                onClick={(e) => e.stopPropagation()}
                className="focus-ring flex min-w-0 items-center gap-1 hover:underline"
              >
                {inside}
              </Link>
            ) : (
              inside
            )}
          </span>
        )
      })}
      {rest > 0 ? (
        <span className="shrink-0 mono text-micro text-graphite">+{rest}</span>
      ) : null}
    </div>
  )
}
