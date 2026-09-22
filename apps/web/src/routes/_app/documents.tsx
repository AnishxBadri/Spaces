import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import { FileText, Layers, Upload } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
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
import { Segmented } from '#/components/ui/segmented'
import { RecordTable, TableToolbar } from '#/components/table/record-table'
import { useTablePrefs } from '#/components/table/use-table-prefs'
import { useViewState } from '#/components/views/use-view-state'
import { ViewBar } from '#/components/views/view-bar'
import { DOCUMENT_KIND_LABELS, formatBytes } from '@spaces/core/documents'
import { formatSince } from '@spaces/core/format'
import { matchesConditions } from '@spaces/core/views/filter'
import {
  DOCUMENT_EXTRACTION_LABELS,
  documentFieldType,
  documentRegistry,
} from '#/lib/documents/registry'
import { projectDocument } from '#/lib/documents/project'
import { recordPath } from '#/lib/record-path'
import type { ViewRow } from '#/lib/views/store'
import { getSession, listDocuments, listViews } from '#/lib/server-fns'
import { openUploadDialog } from '#/lib/upload-dialog-store'

/**
 * `/documents` — the fund's files as a set (SPA-58).
 *
 * This is **a shelf** (`docs/design-contract.md` §3): a list of things with no
 * object row behind them. So its columns are hand-declared with
 * `createColumnHelper` over `RecordTable` + `TableToolbar` like `/portfolio`,
 * and deliberately not generated from the attribute registry like
 * `/companies` — a document has no `entity.values` and no object row, so the
 * registry has nothing here to generate from.
 *
 * It nevertheless saves **views** (docsurf-12a), and it saves them in the same
 * `ViewBar` the four object lists use — no second bar. That is what `D2`
 * bought: `view.surface` is `document` here and `object_id` is null, so
 * `listViews({ surface: 'document' })` hands back `objectId: null` and
 * `viewTarget(null)` inside the bar turns it back into the document key.
 *
 * Since docsurf-12b (SPA-141) it **filters** too, through the same bar. The
 * registry the condition editor draws from is declared in code rather than
 * read from the `attribute` table — `lib/documents/registry.ts` says why that
 * is legitimate — and `lib/documents/project.ts` turns each loaded row into
 * the values record `matchesConditions` already reads. The pure filter model
 * (`@spaces/core/views/filter`) gains nothing: no operator, no branch, no
 * knowledge that documents exist. Evaluation is client-side over the loaded
 * rows, as on every other unpaginated table.
 *
 * **Column widths stay in `useTablePrefs` under a frozen key**, as on every
 * other list: `view.columns` is `Record<string, boolean>` — visibility only —
 * so a view cannot carry a width, and a width is about this screen rather than
 * about the view anyway.
 *
 * A row opens the preview rather than navigating: a document has no page, by
 * decision (`docs/spec-storage-sources.md` §3.2) — inspection, not a
 * destination. The filename is a real button inside the sticky cell so the
 * keyboard reaches it, exactly where `/portfolio` puts its link.
 *
 * The route is addressable by URL from this slice and nothing links to it
 * yet: the nav row and its G-chord are docsurf-5b, and the nav grammar is one
 * row of data in `NAV_ITEMS` when that slice comes.
 *
 * `?filed=unfiled` is the unfiled inbox (SPA-124): a filter on the shelf, not
 * a route — no second table, no second empty state, no second definition of
 * what a document is. That makes it a **search param**, which is what buys
 * reload, back/forward and a linkable badge on Today for free; the toolbar's
 * toggle writes the param and reads it back and holds no state of its own, so
 * the URL is the one place the answer lives.
 *
 * A view now carries it in `extra` (docsurf-12b, D3) — saved with the toggle
 * as it stands, and written back into the param when the view is applied —
 * but the param stays the truth and stays addressable on its own, so
 * `?filed=unfiled` with no `?view=` is exactly what it was. It is deliberately
 * **not** a condition: it is a server-side slice (a `loaderDeps` key, one
 * `where` clause) and the target Today's readout cell links to, and folding it
 * into the condition list would make the badge and the link disagree.
 */
/**
 * `loaderDeps` is what re-runs the loader when the param changes — a loader
 * that ignored it would render the previous filter's rows under the new URL.
 * `.catch('all')` rather than a bare default: a hand-typed `?filed=nonsense`
 * should land on the shelf, not on an error boundary.
 */
/**
 * `view` is the saved view being shown, and it is **not** in `loaderDeps`:
 * applying a view is a client-side change of column visibility and sort, so
 * re-running the loader for it would refetch every row to render the same
 * rows. `filed` is in, because it changes which rows the server sends.
 * The two are independent params on purpose — `?filed=unfiled&view=…` is a
 * legal URL, and every control below writes its own key and leaves the other
 * alone. Applying a view is the one crossing: it carries `filed` in its
 * `extra` and writes the param, which costs one loader run and is why that
 * sync is a navigation rather than the render-time seed the columns get.
 */
const documentsSearch = z.object({
  filed: z.enum(['all', 'unfiled']).catch('all').default('all'),
  view: z.string().optional(),
})

export const Route = createFileRoute('/_app/documents')({
  validateSearch: documentsSearch,
  loaderDeps: ({ search }) => ({ filed: search.filed }),
  loader: async ({ deps }) => {
    const [documents, viewData, session] = await Promise.all([
      listDocuments({ data: { filed: deps.filed } }),
      listViews({ data: { surface: 'document' } }),
      getSession(),
    ])
    return {
      documents,
      views: viewData.views,
      // Null by construction on this surface — the `view_surface_object_id`
      // CHECK says so — and passed through rather than written as `null` here
      // so the bar reads the server's answer, not the page's assumption.
      objectId: viewData.objectId,
      me: session?.user ?? null,
    }
  },
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
  const { documents, views, objectId, me } = Route.useLoaderData()
  const { filed, view: activeId } = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const [globalFilter, setGlobalFilter] = useState('')
  const [previewing, setPreviewing] = useState<DocumentRow | null>(null)
  const prefs = useTablePrefs(PREFS_KEY)

  /**
   * `?view=` on a cold load — a pasted link, a reload, a second user opening
   * a shared view. `useViewState` pushes a view's columns when the active id
   * *changes*; arriving already on one is not a change, so the shelf seeds
   * them itself, once. It runs **during render**, so the first paint is
   * already the view's layout rather than the browser's last local one — the
   * sort and conditions come from the hook's own initializers for the same
   * reason. (The four object lists have the same gap and would want the same
   * seed lifted into the hook; that is not this slice's file to open.)
   */
  const [seeded, setSeeded] = useState(false)
  if (!seeded) {
    setSeeded(true)
    const arriving = views.find((v) => v.id === activeId)
    if (arriving) prefs.setColumnVisibility(arriving.columns)
  }

  const vs = useViewState({
    views,
    activeId: activeId ?? null,
    columnVisibility: prefs.columnVisibility,
    setColumnVisibility: prefs.setColumnVisibility,
    defaultExtra: {},
  })
  const { sorting, setSorting } = vs

  /**
   * Write the `view` key and leave `filed` where it is. The `filed` toggles
   * below do the mirror of this, so neither control can clear the other's
   * param — `?filed=unfiled` survives applying a view, and a view survives
   * switching to the unfiled inbox.
   */
  const selectView = (id: string | null) =>
    void navigate({
      search: (prev) => ({
        filed: prev.filed,
        ...(id === null ? {} : { view: id }),
      }),
    })

  /**
   * Applying a view writes both keys in one navigation: its `extra.filed`
   * into the param, and its own id. "All" (`v === null`) leaves `filed`
   * alone — the bare param is addressable on its own and clearing a view is
   * not a statement about the inbox.
   */
  const applyView = (v: ViewRow | null) => {
    vs.apply(v)
    const stored = v?.extra.filed
    void navigate({
      search: (prev) => ({
        filed: stored === 'all' || stored === 'unfiled' ? stored : prev.filed,
        ...(v === null ? {} : { view: v.id }),
      }),
    })
  }

  /**
   * The other way in: a pasted `?view=` link, a reload, back/forward. Columns
   * and conditions are seeded during render (above, and in `useViewState`'s
   * initializers) because they are React state; `filed` is a `loaderDeps` key,
   * so restoring it is a navigation and a navigation cannot happen during a
   * render. `undefined` as the initial value is what makes the first pass
   * count as a change — `null` is the legitimate "no view" id.
   *
   * It fires only when the *view id* changes, which is what keeps it off the
   * toggle's back: flipping Unfiled while a view is active changes `filed`
   * and not `activeId`, so this sees nothing to do and the snapshot simply
   * goes dirty.
   */
  const storedFiled = views.find((v) => v.id === activeId)?.extra.filed
  const [filedSyncedFor, setFiledSyncedFor] = useState<
    string | null | undefined
  >(undefined)
  useEffect(() => {
    if (filedSyncedFor === (activeId ?? null)) return
    setFiledSyncedFor(activeId ?? null)
    if (
      (storedFiled === 'all' || storedFiled === 'unfiled') &&
      storedFiled !== filed
    )
      void navigate({
        search: (prev) => ({ ...prev, filed: storedFiled }),
        replace: true,
      })
  }, [activeId, filed, filedSyncedFor, navigate, storedFiled])

  /**
   * The surface's field list, with the space and record options filled from
   * the rows on screen (`lib/documents/registry.ts`). Memoized on the rows so
   * the popover's pickers do not get a fresh option array every render.
   */
  const registry = useMemo(() => documentRegistry(documents), [documents])

  /**
   * Conditions run before the table, the way `/deals` narrows by stage before
   * its table: the free-text box is the table's own filter and these are the
   * view's, and the toolbar's "N of M" should count the shelf, not the
   * conditions.
   */
  const rows = useMemo(
    () =>
      vs.conditions.length === 0
        ? documents
        : documents.filter((r) =>
            matchesConditions(
              projectDocument(r),
              vs.conditions,
              documentFieldType,
            ),
          ),
    [documents, vs.conditions],
  )

  const columns = useMemo(() => {
    const defs: Array<ColumnDef<DocumentRow, unknown>> = [
      col.accessor((r) => r.filename, {
        id: 'filename',
        header: 'File',
        size: 280,
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
        size: 110,
        cell: (info) => (
          <span className="block truncate px-1">
            {DOCUMENT_KIND_LABELS[info.row.original.kind]}
          </span>
        ),
      }),
      col.accessor((r) => chipSortKey(r.records.map((x) => x.name)), {
        id: 'records',
        header: 'Filed against',
        size: 240,
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
        size: 200,
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
        size: 200,
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
              {/* A clipped article, which has an address and no bytes
                  (docsurf-10b): "Open source" is the only place to go, since
                  there is no blob to download and the preview shows the
                  extracted text. Never rendered beside the button above — a
                  clip's `external_url` is null by construction
                  (`lib/documents/clip.ts`). */}
              {r.blobSha === null && r.url !== null ? (
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
        size: 140,
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
        cell: (info) => {
          const r = info.row.original
          return (
            // `sinceMs` was measured on the server; formatting the browser's
            // own clock here would render one string during SSR and another
            // during hydration.
            <span
              title={r.createdAt.slice(0, 10)}
              className="block truncate px-1 mono text-label text-graphite"
            >
              {formatSince(r.sinceMs)} ago
            </span>
          )
        },
      }),
      col.accessor((r) => r.sizeBytes ?? -1, {
        id: 'size',
        header: 'Size',
        size: 90,
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
    data: rows,
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

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Documents"
        description="Every file in the workspace, with what it is filed against. Kind, filing and space are the three axes a folder tree encodes — there are no folders."
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
      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        {documents.length === 0 ? (
          /* Two empties, because they mean opposite things. An empty
             workspace is an invitation; an empty *filter* is the inbox being
             clear, which is good news — and its action is the only way back
             to the shelf, since the toolbar carrying the toggle is exactly
             what this branch replaces. */
          filed === 'unfiled' ? (
            <EmptyState
              icon={FileText}
              title="Nothing unfiled."
              body="Every document in the workspace is filed against a record or into a space."
              action={
                <Button
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      search: (prev) => ({ ...prev, filed: 'all' }),
                    })
                  }
                >
                  Show all documents
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={FileText}
              title="No documents yet"
              body="Upload one here and leave it unfiled until you know whose it is, or drop it on a company's Files tab."
            />
          )
        ) : (
          <>
            <TableToolbar
              table={table}
              filter={globalFilter}
              onFilterChange={setGlobalFilter}
              filterPlaceholder="Filter by name or text…"
              filterLabel="Filter documents"
              noun={{ one: 'document', many: 'documents' }}
              total={documents.length}
              shown={table.getRowModel().rows.length}
            >
              <ViewBar
                objectId={objectId}
                registry={registry}
                views={views}
                activeId={activeId ?? null}
                /*
                  `filed` is read off the URL rather than out of the hook's
                  `extra`: the param is this surface's one source of truth for
                  it (see the route comment), so the snapshot the bar saves
                  and compares is what the address bar says, and the two can
                  never drift.
                */
                snapshot={{ ...vs.snapshot, extra: { filed } }}
                onApply={applyView}
                selectView={selectView}
                onFilterChange={vs.setConditions}
                onSaved={() => router.invalidate()}
                canEdit={(v) => v.createdBy === me?.id || me?.role === 'admin'}
              />
              {/* The toggle writes the URL and reads it back — no local
                  state, so a reload, a back button and Today's badge all land
                  on the same view the control is showing. */}
              <Segmented
                size="sm"
                label="Filed"
                value={filed}
                options={[
                  { id: 'all', label: 'All' },
                  { id: 'unfiled', label: 'Unfiled' },
                ]}
                onChange={(next) =>
                  void navigate({
                    search: (prev) => ({ ...prev, filed: next }),
                  })
                }
              />
            </TableToolbar>
            <RecordTable
              table={table}
              label="Documents"
              stickyColumnId="filename"
              onRowClick={setPreviewing}
            />
          </>
        )}
      </div>
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
