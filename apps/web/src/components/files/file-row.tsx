import { useRouter } from '@tanstack/react-router'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { MENU_RULE, MoreMenu } from '../ui/more-menu'
import { cellsFor } from '../dither'
import { FileGlyph } from './file-glyph'
import { icon } from '#/components/icons'
import { brandOf, ProviderMark } from '#/components/provider-mark'
import { NewerVersionDialog } from './newer-version-dialog'
import { FileOnDialog } from './file-on-dialog'
import { FileNameLink } from './file-window-nav'
import { keepCopyItems, useKeepCopy } from './keep-copy'
import { bytesUrl } from '../document-preview'
import { deletableRow, useDeleteFile, useDeletingFiles } from './delete-file'
import { unfileWithUndo } from './unfile'
import type { FileAction, RecordDocument } from './types'
import { DOCUMENT_KIND_LABELS, formatBytes } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import {
  followDocument,
  getDocumentDownloadUrl,
  setDocumentKind,
  unfollowDocument,
} from '#/lib/server-fns'
import {
  KIND_ORDER,
  endLane,
  fileType,
  followLane,
  googleNative,
  stateWord,
} from '#/lib/documents/files-tab'
import type { StateWord } from '#/lib/documents/files-tab'
import { storageLinkProvider } from '#/lib/documents/storage-link'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

/**
 * A Files-tab row: the type glyph, the name, the mono end lane, the
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

export async function downloadDocument(id: string, fromMailbox = false) {
  // A file still in the mailbox is fetched first; the wait is said once.
  if (fromMailbox) {
    let told = false
    const answer = await bytesUrl(
      id,
      () => true,
      (from) => {
        if (!told) toast.message(`Fetching from ${from}…`)
        told = true
      },
    ).catch((err: unknown) => ({
      unavailable: err instanceof Error ? err.message : 'Could not download',
    }))
    if ('url' in answer) window.location.href = answer.url
    else toast.error(answer.unavailable)
    return
  }
  try {
    const { url } = await getDocumentDownloadUrl({ data: { id } })
    window.location.href = url
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not download')
  }
}

/** Whether the file follows its provider right now: Unfollow, not Follow. */
export function isFollowing(
  doc: Pick<RecordDocument, 'follow' | 'externalStatus'>,
) {
  return (
    doc.follow !== null &&
    doc.follow.status !== 'paused' &&
    doc.externalStatus !== 'gone'
  )
}

/** Follow or Unfollow a file, then refresh the tab; the failure is toasted. */
export function useFollow(recordId: string) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function toggle(doc: RecordDocument) {
    setBusy(true)
    try {
      if (isFollowing(doc))
        await unfollowDocument({ data: { documentId: doc.id } })
      else {
        const outcome = await followDocument({
          data: { documentId: doc.id, recordId },
        })
        if (outcome._tag === 'refused') toast.error(outcome.reason)
      }
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not follow')
    } finally {
      setBusy(false)
    }
  }

  return { busy, toggle }
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
  successor = null,
  className,
  onView,
}: {
  doc: RecordDocument
  recordId: string
  recordName: string
  /** A file in a bound Drive folder: Drive's tree, not the kind bands. */
  inFolder?: boolean
  actions?: ReadonlyArray<FileAction>
  /** Files this one may be the newer version of; none hides the item. */
  older?: ReadonlyArray<RecordDocument>
  /** The version number of the file that supersedes this one. */
  successor?: number | null
  className?: string | undefined
  onView: () => void
}) {
  const router = useRouter()
  const { deleteFile, deleteDialog } = useDeleteFile()
  const [versioning, setVersioning] = useState(false)
  const [filingOn, setFilingOn] = useState(false)
  const keeper = useKeepCopy()
  const follow = useFollow(recordId)
  const { today } = useClock()
  const followed = followLane(doc, today)
  const deleting = useDeletingFiles()

  async function setKind(kind: DocumentKind) {
    if (kind === doc.kind) return
    try {
      await setDocumentKind({ data: { documentId: doc.id, kind } })
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change kind')
    }
  }

  const link =
    doc.externalUrl === null ? null : storageLinkProvider(doc.externalUrl)
  const where =
    doc.externalUrl === null
      ? null
      : (link?.label ?? doc.sourceCapability ?? 'source')
  // `Open in Drive ↗` leads with Drive's mark; a source with no mark of its
  // own leaves the app on the launch glyph.
  const whereBrand =
    link !== null
      ? brandOf(`${link.provider} ${link.product}`)
      : where === null
        ? null
        : brandOf(where)

  // Gone the moment the delete is confirmed; a failed delete brings it back.
  if (deleting.has(doc.id)) return null

  return (
    <li
      data-file={doc.id}
      data-row
      data-superseded={doc.replacedBy === null ? undefined : ''}
      className={cn(
        'flex h-ledger-row items-center gap-3 border-b border-rule px-(--inset)',
        doc.replacedBy !== null && 'text-graphite',
        className,
      )}
    >
      <FileGlyph type={fileType(doc)} />
      <FileNameLink
        id={doc.id}
        onOpen={() => openFile(doc, onView)}
        className="focus-ring min-w-0 flex-1 truncate text-left text-body hover:underline"
      >
        {doc.filename}
      </FileNameLink>
      <span
        data-file-end
        className="min-w-0 shrink truncate mono text-micro text-graphite"
      >
        {followed === null
          ? endLane(
              doc,
              today,
              inFolder,
              doc.replacedBy === null ? null : successor,
            )
          : followed.end}
      </span>
      <StateLane state={followed === null ? stateWord(doc) : followed.state} />
      <MoreMenu
        variant="row"
        label={doc.filename}
        items={[
          {
            label: 'Open',
            icon: <icon.open />,
            onSelect: () => openFile(doc, onView),
          },
          ...(doc.blobSha === null && doc.remoteBytes !== 'linked'
            ? []
            : [
                {
                  label: 'Download',
                  icon: <icon.download />,
                  onSelect: () =>
                    void downloadDocument(doc.id, doc.blobSha === null),
                },
              ]),
          ...keepCopyItems(doc, keeper),
          ...(doc.fromEmail
            ? [
                {
                  label: 'File under…',
                  icon: <icon.fileOn />,
                  opens: true,
                  onSelect: () => setFilingOn(true),
                },
              ]
            : []),
          ...(doc.externalUrl === null || where === null
            ? []
            : [
                {
                  label: `Open in ${where}`,
                  icon:
                    whereBrand === null ? (
                      <icon.openOutside />
                    ) : (
                      <ProviderMark brand={whereBrand} />
                    ),
                  href: doc.externalUrl,
                },
              ]),
          ...(isFollowing(doc)
            ? [
                {
                  label: 'Unfollow',
                  icon: <icon.unfollow />,
                  disabled: follow.busy,
                  onSelect: () => void follow.toggle(doc),
                },
              ]
            : doc.canFollow
              ? [
                  {
                    label: 'Follow',
                    icon: <icon.follow />,
                    hint: 'keeps revisions',
                    disabled: follow.busy,
                    onSelect: () => void follow.toggle(doc),
                  },
                ]
              : []),
          ...(inFolder
            ? []
            : [
                {
                  label: 'Change kind',
                  icon: <icon.changeKind />,
                  items: KIND_ORDER.map((kind) => ({
                    label: DOCUMENT_KIND_LABELS[kind],
                    checked: kind === doc.kind,
                    onCheckedChange: () => void setKind(kind),
                  })),
                },
                ...(older.length === 0
                  ? []
                  : [
                      {
                        label: 'Newer version of…',
                        icon: <icon.version />,
                        opens: true,
                        onSelect: () => setVersioning(true),
                      },
                    ]),
              ]),
          MENU_RULE,
          ...actions.map((a) => ({
            label: a.busy ? a.busyLabel : a.label,
            icon: a.icon,
            disabled: a.busy,
            onSelect: a.run,
          })),
          MENU_RULE,
          {
            label: `Unfile from ${recordName}`,
            icon: <icon.unfile />,
            onSelect: () =>
              void unfileWithUndo({
                documentId: doc.id,
                target: { kind: 'record', entityId: recordId },
                name: recordName,
                refresh: () => router.invalidate(),
              }),
          },
          {
            label: 'Delete…',
            icon: <icon.delete />,
            destructive: true,
            opens: true,
            onSelect: () => void deleteFile(deletableRow(doc)),
          },
        ]}
      />
      {deleteDialog}
      {doc.fromEmail ? (
        <FileOnDialog doc={doc} open={filingOn} onOpenChange={setFilingOn} />
      ) : null}
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
    <li className="flex min-h-ledger-row items-center gap-3 border-b border-rule bg-selected px-(--inset) py-1.5">
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

/** A dithered progress bar, filled from the left; 120 by 10 unless told. */
export function DitherBar({
  fraction,
  width = 120,
  height = 10,
}: {
  fraction: number
  width?: number
  height?: number
}) {
  const id = useId()
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * (width - 2))
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
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
        height={height - 1}
        fill="none"
        stroke="currentColor"
      />
      <rect
        x="1"
        y="1"
        width={filled}
        height={height - 2}
        fill={`url(#${id})`}
      />
    </svg>
  )
}
