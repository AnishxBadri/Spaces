import { useRouter } from '@tanstack/react-router'
import { CheckIcon } from 'lucide-react'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { useConfirm } from '../ui/confirm-dialog'
import type { ConfirmOptions } from '../ui/confirm-dialog'
import { cellsFor } from '../dither'
import { FileGlyph } from './file-glyph'
import { NewerVersionDialog } from './newer-version-dialog'
import type { FileAction, FilingEdge, RecordDocument } from './types'
import { DOCUMENT_KIND_LABELS, formatBytes } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import {
  deleteDocument,
  getDocumentDetails,
  getDocumentDownloadUrl,
  setDocumentKind,
  unfileDocument,
} from '#/lib/server-fns'
import {
  KIND_ORDER,
  endLane,
  fileType,
  googleNative,
  stateWord,
} from '#/lib/documents/files-tab'
import type { StateWord } from '#/lib/documents/files-tab'
import { storageLinkProvider } from '#/lib/documents/storage-link'
import { cn } from '#/lib/utils'

/**
 * A Files-tab row (D66): the type glyph, the name, the mono end lane, the
 * lowercase state word, and a `···` holding everything else. No icon strip
 * and no extracted-text line — the menu holds the actions, and the text is a
 * search result, not a file fact.
 */

const TONES: Record<StateWord['tone'], string> = {
  ink: 'text-foreground',
  graphite: 'text-graphite',
  warning: 'text-warning',
  destructive: 'text-destructive',
}

/** The state lane: a fixed width so the end lanes align down the tab. */
export function StateLane({ state }: { state: StateWord | null }) {
  return (
    <span
      className={cn(
        'flex w-24 shrink-0 justify-end mono text-micro',
        state?.wide === true && 'w-auto max-w-56 min-w-24',
      )}
    >
      {state === null ? null : state.href === null ? (
        <span
          className={cn('truncate', TONES[state.tone])}
          title={
            state.title === null || state.title === '' ? undefined : state.title
          }
        >
          {state.text}
        </span>
      ) : (
        <a
          href={state.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={cn('focus-ring hover:underline', TONES[state.tone])}
        >
          {state.text}
        </a>
      )}
    </span>
  )
}

/** The `···` trigger every row ends on. */
function MenuTrigger({ name }: { name: string }) {
  return (
    <DropdownMenuTrigger
      aria-label={`More for ${name}`}
      className="focus-ring flex size-6 shrink-0 items-center justify-center rounded-md mono text-ui text-graphite hover:bg-bone hover:text-foreground data-[state=open]:bg-hairline data-[state=open]:text-paper"
    >
      <span aria-hidden>···</span>
    </DropdownMenuTrigger>
  )
}

export async function downloadDocument(id: string) {
  try {
    const { url } = await getDocumentDownloadUrl({ data: { id } })
    window.location.href = url
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not download')
  }
}

/** Opens a file: a Google Doc, Sheet or Slides file in Google, anything else in the viewer. */
export function openFile(doc: RecordDocument, onView: () => void) {
  if (googleNative(doc) !== null && doc.externalUrl !== null)
    window.open(doc.externalUrl, '_blank', 'noopener,noreferrer')
  else onView()
}

export function FileRow({
  doc,
  recordId,
  recordName,
  inFolder = false,
  actions = [],
  older = [],
  className,
  onView,
}: {
  doc: RecordDocument
  recordId: string
  recordName: string
  /** A file in a bound Drive folder: Drive's tree, `Remove from record`. */
  inFolder?: boolean
  actions?: ReadonlyArray<FileAction>
  /** Files this one may be the newer version of; none hides the item. (A7) */
  older?: ReadonlyArray<RecordDocument>
  className?: string | undefined
  onView: () => void
}) {
  const router = useRouter()
  const { remove, removeDialog } = useRemoveFile(recordId, recordName)
  const [versioning, setVersioning] = useState(false)

  async function setKind(kind: DocumentKind) {
    if (kind === doc.kind) return
    try {
      await setDocumentKind({ data: { documentId: doc.id, kind } })
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change kind')
    }
  }

  const where =
    doc.externalUrl === null
      ? null
      : (storageLinkProvider(doc.externalUrl)?.label ??
        doc.sourceCapability ??
        'source')

  return (
    <li
      data-file={doc.id}
      className={cn(
        'flex h-ledger-row items-center gap-3 border-b border-rule px-3',
        className,
      )}
    >
      <FileGlyph type={fileType(doc)} />
      <button
        type="button"
        onClick={() => openFile(doc, onView)}
        className={cn(
          'focus-ring min-w-0 flex-1 truncate text-left text-body hover:underline',
          doc.replacedBy !== null && 'text-graphite',
        )}
      >
        {doc.filename}
      </button>
      <span className="min-w-0 shrink truncate mono text-micro text-graphite">
        {endLane(doc, inFolder)}
      </span>
      <StateLane state={stateWord(doc, inFolder)} />
      <DropdownMenu>
        <MenuTrigger name={doc.filename} />
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => openFile(doc, onView)}>
            Open
          </DropdownMenuItem>
          {doc.blobSha === null ? null : (
            <DropdownMenuItem onSelect={() => void downloadDocument(doc.id)}>
              Download
            </DropdownMenuItem>
          )}
          {doc.externalUrl === null || where === null ? null : (
            <DropdownMenuItem asChild>
              <a
                href={doc.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in {where}
              </a>
            </DropdownMenuItem>
          )}
          {inFolder ? null : (
            <>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Change kind</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  {KIND_ORDER.map((kind) => (
                    <DropdownMenuItem
                      key={kind}
                      onSelect={() => void setKind(kind)}
                      className={cn(kind === doc.kind && 'bg-selected')}
                    >
                      {DOCUMENT_KIND_LABELS[kind]}
                      {kind === doc.kind ? (
                        <CheckIcon
                          aria-label="current"
                          className="ml-auto size-3 text-foreground"
                        />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {older.length === 0 ? null : (
                <DropdownMenuItem onSelect={() => setVersioning(true)}>
                  Newer version of…
                </DropdownMenuItem>
              )}
            </>
          )}
          {actions.length === 0 ? null : (
            <>
              <DropdownMenuSeparator />
              {actions.map((a) => (
                <DropdownMenuItem
                  key={a.label}
                  disabled={a.busy}
                  onSelect={a.run}
                >
                  {a.busy ? a.busyLabel : a.label}
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => void remove(doc, 'record')}
          >
            {inFolder ? 'Remove from record…' : 'Remove…'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {removeDialog}
      {older.length === 0 ? null : (
        <NewerVersionDialog
          doc={doc}
          older={older}
          open={versioning}
          onOpenChange={setVersioning}
        />
      )}
    </li>
  )
}

/** An upload in flight, landing in its kind at once. */
export type PendingUpload = {
  readonly key: string
  readonly name: string
  readonly kind: DocumentKind
  readonly sizeBytes: number
  readonly phase: 'hashing' | 'uploading' | 'filing'
  /** The PUT's progress, 0 to 1. */
  readonly progress: number
  readonly error: string | null
  readonly cancel: () => void
  /** The born document once the upload committed; the row reads `filed.`. */
  readonly documentId: string | null
  /** "Newer version of": the file it replaces, null for none. */
  readonly olderId: string | null
}

/** The upload's word: `uploading. 42%`, then `filing.`. */
export function pendingWord(p: PendingUpload): string {
  if (p.documentId !== null) return 'filed.'
  if (p.phase === 'filing') return 'filing.'
  if (p.phase === 'hashing') return 'uploading.'
  return `uploading. ${String(Math.round(p.progress * 100))}%`
}

export function PendingRow({
  pending,
  onDismiss,
  version = null,
}: {
  pending: PendingUpload
  onDismiss: () => void
  /** The "Newer version of" field, under the name; null when none applies. */
  version?: ReactNode
}) {
  const failed = pending.error !== null
  const filed = pending.documentId !== null
  return (
    <li className="flex min-h-ledger-row items-center gap-3 border-b border-rule bg-selected px-3 py-1.5">
      <FileGlyph
        type={fileType({
          filename: pending.name,
          mime: null,
          externalUrl: null,
        })}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 truncate text-body">{pending.name}</span>
        {version}
      </div>
      {failed ? (
        <span
          title={pending.error}
          className="min-w-0 shrink truncate text-label text-destructive"
        >
          {pending.error}
        </span>
      ) : (
        <>
          {filed ? null : (
            <DitherBar
              fraction={pending.phase === 'filing' ? 1 : pending.progress}
            />
          )}
          <span className="shrink-0 mono text-micro text-foreground">
            {pendingWord(pending)} · {formatBytes(pending.sizeBytes)}
          </span>
        </>
      )}
      <button
        type="button"
        aria-label={
          failed || filed ? `Dismiss ${pending.name}` : `Cancel ${pending.name}`
        }
        onClick={failed || filed ? onDismiss : pending.cancel}
        className="focus-ring flex size-6 shrink-0 items-center justify-center mono text-micro text-graphite hover:text-foreground"
      >
        ×
      </button>
    </li>
  )
}

/** A dithered progress bar, 120px, filled from the left. */
function DitherBar({ fraction }: { fraction: number }) {
  const id = useId()
  const width = 120
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * (width - 2))
  return (
    <svg
      width={width}
      height="10"
      viewBox={`0 0 ${String(width)} 10`}
      aria-hidden
      shapeRendering="crispEdges"
      className="shrink-0 text-foreground"
    >
      <defs>
        <pattern id={id} width="8" height="8" patternUnits="userSpaceOnUse">
          {cellsFor(8).map(([x, y]) => (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width="2"
              height="2"
              fill="currentColor"
            />
          ))}
        </pattern>
      </defs>
      <rect
        x="0.5"
        y="0.5"
        width={width - 1}
        height="9"
        fill="none"
        stroke="currentColor"
      />
      <rect x="1" y="1" width={filled} height="8" fill={`url(#${id})`} />
    </svg>
  )
}

/**
 * What the Remove confirm says (D66): whether the file leaves the server or
 * only this record, and the ledger of what goes.
 * - `record` removes it from this record; it leaves the server only when it
 *   is filed nowhere else.
 * - `server` deletes it outright, from every record it is filed on.
 */
export function removeConfirmOptions(
  doc: Pick<RecordDocument, 'filename' | 'sizeBytes' | 'filedIn'>,
  {
    recordId,
    recordName,
    mode,
    chunks,
  }: {
    recordId: string
    recordName: string
    mode: 'record' | 'server'
    chunks: number | null
  },
): ConfirmOptions & { leaves: boolean } {
  const elsewhere = doc.filedIn.filter((e) => e.id !== recordId)
  const leaves = mode === 'server' || elsewhere.length === 0
  const names = elsewhere.map((e) => e.name).join(', ')
  const ledger = [
    formatBytes(doc.sizeBytes) || null,
    chunks === null
      ? null
      : `${String(chunks)} chunk${chunks === 1 ? '' : 's'}`,
  ]
    .filter((part) => part !== null)
    .join(' · ')
  if (!leaves)
    return {
      leaves,
      title: `Remove ${doc.filename}?`,
      body: `It is also filed on ${names}, so it stays on the server and leaves only ${recordName}.`,
      rows: elsewhere.map((e: FilingEdge) => ({
        name: `Stays on ${e.name}`,
        meta: e.kind === 'space' ? 'space' : e.entityKind,
      })),
      action: 'Remove',
    }
  return {
    leaves,
    title: `${mode === 'server' ? 'Delete' : 'Remove'} ${doc.filename}?`,
    body:
      elsewhere.length === 0
        ? `It is filed only on ${recordName}, so it leaves the server.`
        : `It leaves ${recordName}, ${names} and the server.`,
    rows: [{ name: 'Leaves the server', meta: ledger }],
    action: mode === 'server' ? 'Delete' : 'Remove',
  }
}

/** Remove (or delete) a file behind the D66 confirm, then refresh the tab. */
export function useRemoveFile(recordId: string, recordName: string) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()

  async function remove(
    doc: RecordDocument,
    mode: 'record' | 'server',
  ): Promise<boolean> {
    // The chunk count is only for the ledger: a confirm without it still says
    // what leaves.
    const details = await getDocumentDetails({ data: { id: doc.id } }).catch(
      () => null,
    )
    const { leaves, ...options } = removeConfirmOptions(doc, {
      recordId,
      recordName,
      mode,
      chunks: details?.chunks ?? null,
    })
    if (!(await confirm(options))) return false
    try {
      if (leaves) await deleteDocument({ data: { id: doc.id } })
      else
        await unfileDocument({
          data: {
            documentId: doc.id,
            target: { kind: 'record', entityId: recordId },
          },
        })
      await router.invalidate()
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove')
      return false
    }
  }

  return { remove, removeDialog: confirmDialog }
}
