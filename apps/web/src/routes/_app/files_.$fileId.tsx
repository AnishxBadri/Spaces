import { Link, createFileRoute } from '@tanstack/react-router'
import { FileView } from '#/components/files/file-view'
import { ChevronLeft } from '#/components/icons'
import { ListPage } from '#/components/page-header'
import {
  RecordGone,
  RecordHeadPending,
  RecordLoadFailed,
} from '#/components/record/record-parts'
import { loadFilePage } from '#/lib/documents/file-page'

/**
 * A file as a page, inside the app shell so the sidebar stays: a 36px bar
 * with `‹ Files` above the head the window carries, without the window's
 * close or `Open as a page`. Its rail's writes invalidate the router, which
 * reruns the loader.
 * - A fixed pane from `md`: the pages scroll in their own column, which is
 *   what lets the body draw only the pages near it and the pager follow.
 */
export const Route = createFileRoute('/_app/files_/$fileId')({
  loader: ({ params }) => loadFilePage(params.fileId),
  component: FilePage,
  pendingComponent: () => <RecordHeadPending kind="File" />,
  notFoundComponent: () => (
    <RecordGone kind="File" listTo="/files" listLabel="Open Files" />
  ),
  errorComponent: ({ error }) => <RecordLoadFailed kind="File" error={error} />,
})

function FilePage() {
  const view = Route.useLoaderData()
  return (
    <ListPage>
      <nav
        aria-label="Back to Files"
        className="flex h-9 shrink-0 items-center border-b border-rule bg-paper px-6"
      >
        <Link
          to="/files"
          className="focus-ring flex items-center gap-1.5 text-ui text-foreground hover:underline"
        >
          <ChevronLeft aria-hidden className="size-4 text-graphite" />
          Files
        </Link>
      </nav>
      <FileView view={view} startPage={1} container="page" />
    </ListPage>
  )
}
