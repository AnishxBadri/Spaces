import { useState } from 'react'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Segmented } from '../ui/segmented'
import { FolderGlyph } from './file-glyph'
import { formatBytes } from '@spaces/core/documents'

/**
 * Link a Drive folder: a window titled with the Drive path in mono —
 * where the files land, what is inside, and the three options whose hints
 * survive the invariant-line test (cost, privacy, consequence).
 * - Presentational: the caller binds and says how it went; a refusal (the
 *   folder already has an owner) stays in the window, above the foot.
 * - The dialog sets no direction: a binding made here reads, Drive → us.
 * - Each option's behaviour lives elsewhere: Keep `text` drops the bytes
 *   after extraction (`dropBytesAfterExtraction`) and a flip to `full`
 *   backfills (`setBindingRetain`).
 */

/** What Link folder stores on the binding. */
export type FolderOptions = {
  readonly mapSubfolders: boolean
  readonly retain: 'full' | 'text'
  readonly direction: 'pull'
  readonly sensitivity: 'inherit' | 'sensitive'
}

export const DEFAULT_FOLDER_OPTIONS: FolderOptions = {
  mapSubfolders: true,
  retain: 'full',
  direction: 'pull',
  sensitivity: 'inherit',
}

export type FolderInside = {
  readonly files: number
  readonly folders: number
  readonly bytes: number
}

export function LinkFolderDialog({
  path,
  recordName,
  inside,
  onOpenChange,
  onLink,
  linking = false,
  refusal = null,
  initial = DEFAULT_FOLDER_OPTIONS,
}: {
  /** The folder as Drive names it, or the link pasted; null when closed. */
  path: string | null
  recordName: string
  /** What the folder holds, once listed; null when not known. */
  inside: FolderInside | null
  onOpenChange: (open: boolean) => void
  onLink: (options: FolderOptions) => void
  /** The bind is on its way; Link folder waits. */
  linking?: boolean
  /** Why the last Link folder was refused; null for none. */
  refusal?: string | null
  /** The options to open with: a bind resumed after Google's consent. */
  initial?: FolderOptions
}) {
  const [mapSubfolders, setMapSubfolders] = useState(initial.mapSubfolders)
  const [keep, setKeep] = useState<'full' | 'text'>(initial.retain)
  const [sensitive, setSensitive] = useState(
    initial.sensitivity === 'sensitive',
  )
  const size = inside === null ? null : formatBytes(inside.bytes)

  return (
    <Dialog open={path !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[34rem]">
        <DialogHeader className="flex-nowrap items-center">
          <FolderGlyph bound className="-my-1 shrink-0" />
          <DialogTitle className="min-w-0 truncate font-mono text-ui font-normal">
            {path}
          </DialogTitle>
        </DialogHeader>
        <dl className="flex flex-col">
          <div className="flex h-9 items-center justify-between gap-3 border-b border-rule">
            <dt className="field-label text-graphite">Files land on</dt>
            <dd className="min-w-0 truncate text-ui">{recordName}</dd>
          </div>
          {inside === null ? null : (
            <div className="flex h-9 items-center justify-between gap-3 border-b border-rule">
              <dt className="field-label text-graphite">Inside</dt>
              <dd className="mono text-micro">
                {`${String(inside.files)} files · ${String(inside.folders)} folders · ${size ?? ''}`}
              </dd>
            </div>
          )}
        </dl>
        <div className="flex gap-2.5 border-b border-rule py-3">
          <Checkbox
            id="link-folder-map"
            checked={mapSubfolders}
            onCheckedChange={setMapSubfolders}
            className="mt-0.5"
          />
          <label htmlFor="link-folder-map" className="flex flex-col gap-0.5">
            <span className="text-ui">Map subfolders</span>
            <span className="text-label text-graphite">
              Folder names set the kind. A folder named like a deal files on
              that deal.
            </span>
          </label>
        </div>
        <div className="flex flex-col gap-1.5 border-b border-rule py-3">
          <span className="text-ui">Keep</span>
          <Segmented
            value={keep}
            onChange={setKeep}
            label="Keep"
            className="w-full [&>button]:flex-1"
            options={[
              { id: 'full', label: 'Full copies' },
              { id: 'text', label: 'Text only' },
            ]}
          />
          <span className="mono text-micro text-graphite">
            {keep === 'full'
              ? `${size === null ? '' : `${size} `}on this server · previews work offline`
              : 'text on this server · previews need Drive'}
          </span>
        </div>
        <div className="flex gap-2.5 pt-3">
          <Checkbox
            id="link-folder-sensitive"
            checked={sensitive}
            onCheckedChange={setSensitive}
            className="mt-0.5"
          />
          <label
            htmlFor="link-folder-sensitive"
            className="flex flex-col gap-0.5"
          >
            <span className="text-ui">Sensitive</span>
            <span className="text-label text-graphite">
              Ask reads these files with a local model only.
            </span>
          </label>
        </div>
        {refusal === null ? null : (
          <p role="alert" className="pt-3 text-label text-destructive">
            {refusal}
          </p>
        )}
        <DialogFooter note="read-only · files under this folder">
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            type="button"
            pending={linking}
            disabled={linking}
            onClick={() =>
              onLink({
                mapSubfolders,
                retain: keep,
                direction: 'pull',
                sensitivity: sensitive ? 'sensitive' : 'inherit',
              })
            }
          >
            Link folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
