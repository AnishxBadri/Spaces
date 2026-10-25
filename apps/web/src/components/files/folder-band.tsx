import { useState } from 'react'
import { formatSince } from '@spaces/core/format'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { FolderGlyph } from './file-glyph'
import { FileRow } from './file-row'
import type { RecordDocument } from './types'
import { folderTree } from '#/lib/documents/files-tab'
import type { FolderNode } from '#/lib/documents/files-tab'
import { cn } from '#/lib/utils'

/**
 * A bound Drive folder: its own band under our files, with Drive's
 * tree, read-only. Subfolders fold; each file is a `FileRow` in folder mode
 * (`edited MM-DD · google ↗` for a native file, `■ gone` for a deleted one).
 * The band renders from the binding its caller hands it; it syncs nothing.
 * - The head ends on its mono lane (`never synced · read-only`) and a `···`
 *   holding Unlink.
 */

/** A folder bound to this record, and the documents its sync filed. */
export type BoundFolder = {
  readonly id: string
  /** The folder's own path in Drive, as each document's `source_path` starts. */
  readonly path: string
  /** How long since the last sync finished; null before the first. */
  readonly syncedSinceMs: number | null
  /** Drive → us only (`direction: pull`). */
  readonly readOnly: boolean
  readonly documents: ReadonlyArray<RecordDocument>
}

/** The head's mono lane: what the sync has done, and which way it runs. */
export function folderLane(folder: BoundFolder, count: number): string {
  const synced =
    folder.syncedSinceMs === null
      ? 'never synced'
      : `${String(count)} · synced ${formatSince(folder.syncedSinceMs)} ago`
  return folder.readOnly ? `${synced} · read-only` : synced
}

export function FolderBand({
  folder,
  recordId,
  recordName,
  onView,
  onUnlink = null,
}: {
  folder: BoundFolder
  recordId: string
  recordName: string
  onView: (doc: RecordDocument) => void
  /** Unlink in the head's `···`; null draws no `···`. */
  onUnlink?: (() => void) | null
}) {
  const tree = folderTree(folder.path, folder.documents)
  return (
    <section aria-label={tree.name} className="mt-6 border-t border-hairline">
      <div className="flex h-ledger-row items-center gap-3 border-b border-rule bg-bone px-3">
        <FolderGlyph bound />
        <h3 className="min-w-0 truncate text-body font-medium">{tree.name}</h3>
        <span className="flex-1" />
        <span className="shrink-0 mono text-micro text-graphite">
          {folderLane(folder, tree.count)}
        </span>
        {onUnlink === null ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More for ${tree.name}`}
              className="focus-ring flex size-6 shrink-0 items-center justify-center rounded-md mono text-ui text-graphite hover:bg-paper hover:text-foreground data-[state=open]:bg-hairline data-[state=open]:text-paper"
            >
              <span aria-hidden>···</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={onUnlink}>Unlink</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <ul>
        <FolderContents
          node={tree}
          depth={0}
          recordId={recordId}
          recordName={recordName}
          onView={onView}
        />
      </ul>
    </section>
  )
}

function FolderContents({
  node,
  depth,
  recordId,
  recordName,
  onView,
}: {
  node: FolderNode<RecordDocument>
  depth: number
  recordId: string
  recordName: string
  onView: (doc: RecordDocument) => void
}) {
  return (
    <>
      {node.folders.map((child) => (
        <Subfolder
          key={child.path}
          node={child}
          depth={depth}
          recordId={recordId}
          recordName={recordName}
          onView={onView}
        />
      ))}
      {node.files.map((doc) => (
        <FileRow
          key={doc.id}
          doc={doc}
          recordId={recordId}
          recordName={recordName}
          inFolder
          className={cn(depth > 0 && 'pl-13')}
          onView={() => onView(doc)}
        />
      ))}
    </>
  )
}

function Subfolder({
  node,
  depth,
  recordId,
  recordName,
  onView,
}: {
  node: FolderNode<RecordDocument>
  depth: number
  recordId: string
  recordName: string
  onView: (doc: RecordDocument) => void
}) {
  const [open, setOpen] = useState(depth === 0)
  return (
    <li className={cn(depth > 0 && 'pl-10')}>
      {/* Subfolders fold; the first level opens. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring-inset flex h-ledger-row w-full items-center gap-3 border-b border-rule px-3 text-left hover:bg-bone"
      >
        <span
          aria-hidden
          className="w-3 shrink-0 mono text-micro text-graphite"
        >
          {open ? '⌄' : '›'}
        </span>
        <FolderGlyph />
        <span className="min-w-0 flex-1 truncate text-body">{node.name}</span>
        <span className="shrink-0 mono text-micro text-graphite">
          {String(node.count)}
        </span>
      </button>
      {open ? (
        <ul>
          <FolderContents
            node={node}
            depth={depth + 1}
            recordId={recordId}
            recordName={recordName}
            onView={onView}
          />
        </ul>
      ) : null}
    </li>
  )
}
