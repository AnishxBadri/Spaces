import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { icon } from '#/components/icons'
import { MENU_RULE, MoreMenu } from '../ui/more-menu'
import type { MoreMenuEntry } from '../ui/more-menu'
import { useDeleteFile } from './delete-file'
import { FileOnDialog } from './file-on-dialog'
import { downloadDocument } from './file-row'
import { NewerVersionDialog } from './newer-version-dialog'
import type { OlderFile } from './newer-version-dialog'
import { DOCUMENT_KIND_LABELS } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import { filingKind } from '#/lib/documents/delete-confirm'
import type { DeletableFile } from '#/lib/documents/delete-confirm'
import type { FilesLedgerRow } from '#/lib/documents/files-ledger'
import { KIND_ORDER } from '#/lib/documents/files-tab'
import { getFileView, setDocumentKind } from '#/lib/server-fns'

/**
 * A Files-page row's `···`: Open, `File under…`, `Kind ›`, `Newer version
 * of…`, a rule, Download, Open in new tab, Copy link, a rule, then
 * `Delete…`. The items are one function so any drawing of the page reuses
 * them.
 */

/** What the menu reads off a row. */
type MenuRow = Pick<
  FilesLedgerRow,
  | 'id'
  | 'filename'
  | 'kind'
  | 'blobSha'
  | 'hasOlder'
  | 'mime'
  | 'externalUrl'
  | 'sizeBytes'
  | 'sourceCapability'
  | 'sourcePath'
  | 'inSyncedFolder'
  | 'versions'
  | 'records'
  | 'spaces'
>

/** A row as the delete confirm reads it. */
export function deletableShelf(doc: MenuRow): DeletableFile {
  return {
    id: doc.id,
    filename: doc.filename,
    mime: doc.mime,
    externalUrl: doc.externalUrl,
    sizeBytes: doc.sizeBytes,
    sourceCapability: doc.sourceCapability,
    sourcePath: doc.sourcePath,
    inSyncedFolder: doc.inSyncedFolder,
    versions: doc.versions,
    filings: [
      ...doc.records.map((r) => ({
        name: r.name,
        kind: filingKind({ kind: 'record', entityKind: r.kind }),
      })),
      ...doc.spaces.map((s) => ({ name: s.name, kind: 'Space' })),
    ],
  }
}

/** The row's items; each `on…` opens its window or writes. */
export function shelfMenuItems(
  doc: Pick<MenuRow, 'id' | 'blobSha' | 'kind' | 'hasOlder'>,
  handlers: {
    onOpen: () => void
    onFileUnder: () => void
    onKind: (kind: DocumentKind) => void
    onNewerVersion: () => void
    onDelete: () => void
  },
): Array<MoreMenuEntry> {
  const page = `/files/${doc.id}`
  return [
    { label: 'Open', icon: <icon.open />, onSelect: handlers.onOpen },
    {
      label: 'File under…',
      icon: <icon.fileIn />,
      opens: true,
      onSelect: handlers.onFileUnder,
    },
    {
      label: 'Kind',
      icon: <icon.changeKind />,
      hint: DOCUMENT_KIND_LABELS[doc.kind],
      items: KIND_ORDER.map((k) => ({
        label: DOCUMENT_KIND_LABELS[k],
        checked: k === doc.kind,
        onCheckedChange: () => handlers.onKind(k),
      })),
    },
    ...(doc.hasOlder
      ? [
          {
            label: 'Newer version of…',
            icon: <icon.version />,
            opens: true,
            onSelect: handlers.onNewerVersion,
          },
        ]
      : []),
    MENU_RULE,
    ...(doc.blobSha === null
      ? []
      : [
          {
            label: 'Download',
            icon: <icon.download />,
            onSelect: () => void downloadDocument(doc.id),
          },
        ]),
    { label: 'Open in new tab', icon: <icon.openOutside />, href: page },
    {
      label: 'Copy link',
      icon: <icon.copyLink />,
      copy: () => new URL(page, window.location.origin).href,
    },
    MENU_RULE,
    {
      label: 'Delete…',
      icon: <icon.delete />,
      destructive: true,
      opens: true,
      onSelect: handlers.onDelete,
    },
  ]
}

export function ShelfRowMenu({
  doc,
  onOpen,
}: {
  doc: MenuRow
  onOpen: () => void
}) {
  const router = useRouter()
  const { deleteFile, deleteDialog } = useDeleteFile()
  const [filing, setFiling] = useState(false)
  // The files it may replace are read when asked for, not for every row.
  const [older, setOlder] = useState<ReadonlyArray<OlderFile> | null>(null)

  async function setKind(next: DocumentKind) {
    if (next === doc.kind) return
    try {
      await setDocumentKind({ data: { documentId: doc.id, kind: next } })
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change kind')
    }
  }

  async function newerVersion() {
    try {
      const view = await getFileView({ data: { id: doc.id } })
      if (view === null || view.older.length === 0) {
        toast.message('No older file of its kind is filed with it')
        return
      }
      setOlder(view.older)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read it')
    }
  }

  return (
    <>
      <MoreMenu
        variant="row"
        label={doc.filename}
        items={shelfMenuItems(doc, {
          onOpen,
          onFileUnder: () => setFiling(true),
          onKind: (k) => void setKind(k),
          onNewerVersion: () => void newerVersion(),
          onDelete: () => void deleteFile(deletableShelf(doc)),
        })}
      />
      <FileOnDialog doc={doc} open={filing} onOpenChange={setFiling} />
      {older === null ? null : (
        <NewerVersionDialog
          doc={doc}
          older={older}
          open
          onOpenChange={(open) => {
            if (!open) setOlder(null)
          }}
        />
      )}
      {deleteDialog}
    </>
  )
}
