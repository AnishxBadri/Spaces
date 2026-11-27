import { createFileRoute } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { icon } from '#/components/icons'
import { useOpenFile } from '#/components/files/file-window-nav'
import { FilesLedger } from '#/components/files/files-ledger'
import { FilesToolbar } from '#/components/files/files-toolbar'
import { EmptyRow } from '#/components/ledger-section'
import { Card, ListPage, PageBody, PageHeader } from '#/components/page-header'
import { Button } from '#/components/ui/button'
import { listFiles } from '#/lib/server-fns'
import { openUploadDialog } from '#/lib/upload-dialog-store'
import { filesSearch } from '#/lib/documents/to-files'
import type { FilesTab } from '#/lib/documents/files-ledger-view'

/** Rows a page of the list holds, and what `Load n more` adds. */
const FILES_STEP = 50

/** The most rows the address may ask for at once. */
const FILES_MAX = 1000

/** The open tab: `All` when the address names no kind. */
const tabOf = (tab: Exclude<FilesTab, 'all'> | undefined): FilesTab =>
  tab ?? 'all'

/**
 * `/files`: every file the reader may read, as a ledger. The page is Files;
 * the rows are `document`s, and every code name keeps that word.
 * - The folder tabs are the kinds; `Unfiled` is the first band, then the
 *   date bands. A fixed pane: the head, the tab bar and the foot stay while
 *   the rows scroll inside the folder.
 * - The address holds the tab (`?tab=deck`), the search (`?q=`) and how
 *   many rows are shown (`?n=100`), so reload, Back and a link land on the
 *   same list; `loaderDeps` re-runs the loader when any changes.
 * - A row opens the file's window over the list (`?modal=file&id=`).
 */
export const Route = createFileRoute('/_app/files')({
  validateSearch: filesSearch,
  loaderDeps: ({ search }) => ({
    tab: tabOf(search.tab),
    q: search.q ?? '',
    n: Math.min(search.n ?? FILES_STEP, FILES_MAX),
  }),
  loader: ({ deps }) =>
    listFiles({ data: { tab: deps.tab, q: deps.q, limit: deps.n } }),
  component: FilesPage,
})

function FilesPage() {
  // The page's title and the open tab name the list to a screen reader.
  const titleId = useId()
  const tabId = useId()
  const ledger = Route.useLoaderData()
  const { tab = 'all', q = '' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const openFile = useOpenFile()
  const [loading, setLoading] = useState(false)

  const go = (patch: {
    tab?: Exclude<FilesTab, 'all'> | undefined
    q?: string | undefined
    n?: number | undefined
  }) =>
    navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
      resetScroll: false,
    })

  return (
    <ListPage>
      <PageHeader
        title="Files"
        titleId={titleId}
        index
        action={
          /* The upload door on the page that lists what it produces. The
             dialog lives in the app shell; the chassis and ⌘K open it too. */
          <Button onClick={openUploadDialog}>
            <icon.upload className="size-4" />
            Upload
          </Button>
        }
      />
      {ledger.counts.all === 0 ? (
        // First run: nothing here — one row that uploads.
        <PageBody>
          <Card>
            <EmptyRow name="Files" onAdd={openUploadDialog} />
          </Card>
        </PageBody>
      ) : (
        <>
          <FilesToolbar
            tab={tab}
            counts={ledger.counts}
            onTabChange={(t) =>
              void go({ tab: t === 'all' ? undefined : t, n: undefined })
            }
            q={q}
            onSearch={(text) =>
              void go({ q: text === '' ? undefined : text, n: undefined })
            }
            labelId={tabId}
          />
          <PageBody className="min-h-0 pt-0">
            <FilesLedger
              ledger={ledger}
              labelledBy={`${titleId} ${tabId}`}
              step={FILES_STEP}
              loading={loading}
              onLoadMore={() => {
                setLoading(true)
                void go({ n: ledger.rows.length + FILES_STEP }).finally(() =>
                  setLoading(false),
                )
              }}
              onOpen={(id) => openFile(id)}
              empty={q === '' ? 'Nothing here yet.' : 'Nothing matches.'}
            />
          </PageBody>
        </>
      )}
    </ListPage>
  )
}
