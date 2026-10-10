import { Link, createFileRoute } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { FileText, Layers, Upload } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DocumentPreview } from '#/components/document-preview'
import {
  GoneMarker,
  OpenInSourceButton,
  OpenSourceButton,
} from '#/components/document-source'
import { DocumentTile } from '#/components/document-tile'
import { KIND_ICONS } from '#/components/editor/mention'
import { EmptyState } from '#/components/empty-state'
import { PageHeader } from '#/components/page-header'
import { Button } from '#/components/ui/button'
import { RecordTable, TableToolbar } from '#/components/table/record-table'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { DOCUMENT_KIND_LABELS, formatBytes } from '@spaces/core/documents'
import { formatSince } from '@spaces/core/format'
import { DOCUMENT_EXTRACTION_LABELS } from '#/lib/documents/registry'
import { recordPath } from '#/lib/record-path'
import { listDocuments } from '#/lib/server-fns'
import { openUploadDialog } from '#/lib/upload-dialog-store'
import { filesSearch } from '#/lib/documents/to-files'

/**
 * `/files` — the fund's files as a set. The page is Files; the rows are
 * `document`s, and every code name keeps that word (D68 amended).
 *
 * This is **a shelf** (`docs/design-contract.md` §3): a list of things with no
 * object row behind them. So its columns are hand-declared with
 * `createColumnHelper` over `RecordTable` like `/portfolio`, and it has **no
 * `ViewBar`**: saved views address objects, and a shelf is not one. Its one
 * filter is `All · Unfiled`, as tabs on the bar, plus the text box.
 *
 * A row opens the preview rather than navigating: a document has no page, by
 * decision (`docs/spec-storage-sources.md` §3.2) — inspection, not a
 * destination. The filename is a real button inside the sticky cell so the
 * keyboard reaches it, exactly where `/portfolio` puts its link.
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
  loader: async ({ deps }) => ({
    documents: await listDocuments({ data: { filed: deps.filed } }),
  }),
  component: DocumentsPage,
})

type DocumentRow = Awaited<ReturnType<typeof listDocuments>>[number]

const col = createColumnHelper<DocumentRow>()
// FROZEN: renaming resets saved column layouts with no recovery path.
const PREFS_KEY = 'dealos.documents-table.v1'

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

/**
 * Who put the bytes here. `manual` covers upload, url and clip — all three
 * are a person choosing a file in a surface we ship — so it reads "Upload";
 * an integration is named, because "integration" tells the reader nothing
 * they could act on and "gmail" is the word they installed.
 */
function originText(r: DocumentRow): string {
  if (r.sourceClass === 'integration')
    return r.sourceCapability ?? 'Integration'
  return 'Upload'
}

/**
 * The Source column's text (SPA-78, `docs/spec-storage-sources.md` §12).
 *
 * Origin alone until a storage source files something; then the provider and
 * the path it sits at over there, so the row reads the way the user would say
 * it out loud — "Drive · Data room / Legal". The path is kept verbatim (§5.3)
 * and printed verbatim: it is a label and a write-back address, and shortening
 * it here would make the two disagree.
 *
 * A null path is the origin on its own, never an empty cell and never a dash —
 * the column said exactly this before this slice, and every existing row still
 * gets exactly this.
 */
function sourceText(r: DocumentRow): string {
  const origin = originText(r)
  return r.sourcePath === null ? origin : `${origin} · ${r.sourcePath}`
}

/**
 * The status word, and whether it is the bad kind. The word itself comes from
 * `DOCUMENT_EXTRACTION_LABELS`, which is also what the Filter popover's
 * Extraction options read — the cell and the filter naming the same state
 * differently is the drift that file exists to prevent.
 */
function extractionText(r: DocumentRow): { text: string; bad: boolean } {
  return {
    text: DOCUMENT_EXTRACTION_LABELS[r.extractionStatus],
    bad: r.extractionStatus === 'failed',
  }
}

function DocumentsPage() {
  const { documents } = Route.useLoaderData()
  const { filed } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [globalFilter, setGlobalFilter] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [previewing, setPreviewing] = useState<DocumentRow | null>(null)
  const prefs = useTablePrefs(PREFS_KEY)

  const columns = useMemo(() => {
    const defs: Array<ColumnDef<DocumentRow, unknown>> = [
      col.accessor((r) => r.filename, {
        id: 'filename',
        header: 'File',
        size: 240,
        enableHiding: false,
        cell: (info) => {
          const r = info.row.original
          return (
            <button
              type="button"
              // The row click does the same thing; without this, clicking the
              // button fires both handlers for one intent.
              onClick={(e) => {
                e.stopPropagation()
                setPreviewing(r)
              }}
              title={`Preview ${r.filename}`}
              className="focus-ring-inset flex h-full w-full min-w-0 items-center gap-2 px-1 text-left font-medium hover:underline"
            >
              <DocumentTile kind={r.kind} filename={r.filename} />
              <span className="truncate">{r.filename}</span>
            </button>
          )
        },
      }),
      col.accessor((r) => DOCUMENT_KIND_LABELS[r.kind], {
        id: 'kind',
        header: 'Kind',
        size: 80,
        cell: (info) => (
          <span className="block truncate px-1">
            {DOCUMENT_KIND_LABELS[info.row.original.kind]}
          </span>
        ),
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
      col.accessor((r) => sourceText(r), {
        id: 'source',
        header: 'Source',
        // Renamed from `origin` by SPA-78, and the id is renamed with the
        // header on purpose: a stored width or hidden flag under the old id
        // is simply not read, so the column comes back at its default once.
        // That is the honest outcome — it is a wider column that now answers
        // a question the old one could not.
        size: 150,
        cell: (info) => {
          const r = info.row.original
          return (
            <div className="flex min-w-0 items-center gap-1.5 px-1">
              <span
                title={sourceText(r)}
                className="min-w-0 truncate text-graphite"
              >
                {sourceText(r)}
              </span>
              {r.externalStatus === 'gone' ? <GoneMarker /> : null}
              {/* Only a row a source actually linked has somewhere to open:
                  an upload, a clip and a url have no external URL, so they
                  get no action rather than a dead one. */}
              {r.externalUrl === null ? null : (
                <OpenInSourceButton
                  url={r.externalUrl}
                  filename={r.filename}
                  className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                />
              )}
              {/* The page a row came from (docsurf-10b, SPA-111): a clipped
                  article, which has an address and no bytes, and a capture,
                  which has both — its text is the blob, the page is its
                  source. Never rendered beside the button above: a clip's and
                  a capture's `external_url` are null by construction
                  (`lib/documents/clip.ts`, `lib/rpc/capture.ts`). */}
              {r.url !== null ? (
                <OpenSourceButton
                  url={r.url}
                  filename={r.filename}
                  className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                />
              ) : null}
            </div>
          )
        },
      }),
      col.accessor((r) => extractionText(r).text, {
        id: 'extraction',
        header: 'Extraction',
        size: 110,
        cell: (info) => {
          const r = info.row.original
          const { text, bad } = extractionText(r)
          const cls = bad
            ? 'block truncate px-1 mono text-label text-destructive'
            : 'block truncate px-1 mono text-label text-graphite'
          // The reason is the title rather than the cell: a stack trace from
          // a broken PDF is a paragraph, and a 36px row is not. Two branches
          // rather than one `?? undefined`, because a document that extracted
          // cleanly has no reason and must not get an empty tooltip.
          return r.extractionError === null ? (
            <span className={cls}>{text}</span>
          ) : (
            <span title={r.extractionError} className={cls}>
              {text}
            </span>
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
            // The ISO day, as every list prints a date; the age is the hover.
            // `sinceMs` was measured on the server, so SSR and hydration agree.
            <span
              title={`${formatSince(r.sinceMs)} ago`}
              className="block truncate px-1 numeric mono text-label text-graphite"
            >
              {r.createdAt.slice(0, 10)}
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
  }, [])

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
        {...(filed === 'all' ? { count: documents.length } : {})}
        action={
          /* §3.1 entry point 3, on the shelf that lists what it produces.
             The dialog lives in the app shell — this is one of its three
             doors, and it opens the same component the chassis and ⌘K do. */
          <Button onClick={openUploadDialog}>
            <Upload className="size-3.5" strokeWidth={2} />
            Upload
          </Button>
        }
      />
      {documents.length === 0 && filed === 'all' ? (
        <div className="px-8 pb-8">
          <EmptyState
            icon={FileText}
            title="No files yet"
            body="Upload one here and leave it unfiled until you know whose it is, or drop it on a company's Files tab."
          />
        </div>
      ) : (
        <>
          <TableToolbar
            table={table}
            label="Files by filing"
            tabs={[
              { id: 'all', label: 'All' },
              { id: 'unfiled', label: 'Unfiled' },
            ]}
            value={filed}
            onValueChange={setFiled}
            filter={globalFilter}
            onFilterChange={setGlobalFilter}
            filterPlaceholder="Filter by name or text…"
            filterLabel="Filter files"
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
