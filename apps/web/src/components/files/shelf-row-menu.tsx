import { icon } from '#/components/icons'
import { MENU_RULE, MoreMenu } from '../ui/more-menu'
import type { MoreMenuEntry } from '../ui/more-menu'
import { useDeleteFile } from './delete-file'
import { downloadDocument } from './file-row'
import { filingKind } from '#/lib/documents/delete-confirm'
import type { DeletableFile } from '#/lib/documents/delete-confirm'
import type { ShelfDocument } from '#/lib/documents/shelf'

/**
 * A Files-page row's `···`: Open, Download, Open in new tab, Copy link, a
 * rule, then `Delete…`. The items are one function so any drawing of the
 * page reuses them.
 */

/** A shelf row as the delete confirm reads it. */
export function deletableShelf(doc: ShelfDocument): DeletableFile {
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

/** The row's items; `onDelete` opens the confirm. */
export function shelfMenuItems(
  doc: Pick<ShelfDocument, 'id' | 'blobSha'>,
  { onOpen, onDelete }: { onOpen: () => void; onDelete: () => void },
): Array<MoreMenuEntry> {
  const page = `/files/${doc.id}`
  return [
    { label: 'Open', icon: <icon.open />, onSelect: onOpen },
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
      onSelect: onDelete,
    },
  ]
}

export function ShelfRowMenu({
  doc,
  onOpen,
}: {
  doc: ShelfDocument
  onOpen: () => void
}) {
  const { deleteFile, deleteDialog } = useDeleteFile()
  return (
    <>
      <MoreMenu
        variant="row"
        label={doc.filename}
        items={shelfMenuItems(doc, {
          onOpen,
          onDelete: () => void deleteFile(deletableShelf(doc)),
        })}
      />
      {deleteDialog}
    </>
  )
}
