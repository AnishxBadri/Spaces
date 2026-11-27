import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { AskButton } from '../ui/ask-control'
import { Button } from '../ui/button'
import { DialogDescription, DialogTitle } from '../ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { MENU_RULE, MoreMenu } from '../ui/more-menu'
import { OpenAsPage, WindowControls } from '../ui/window-controls'
import { blobless } from '../document-preview'
import { ChevronDown, icon } from '#/components/icons'
import { useClock } from '#/components/clock'
import { FileGlyphLarge } from './file-glyph'
import { downloadDocument } from './file-row'
import { NewerVersionDialog } from './newer-version-dialog'
import { laneName } from './viewer-sidebar'
import { DOCUMENT_KIND_LABELS, formatBytes } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import { formatWeekday } from '@spaces/core/format'
import { addMention, openAsk } from '#/lib/ask/dock-store'
import type { AskScopeChip } from '#/lib/ask/types'
import { KIND_ORDER, fileType } from '#/lib/documents/files-tab'
import { reExtractDocument, setDocumentKind } from '#/lib/server-fns'
import type { getFileView } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * A file's head, the same in its window and on its page: the large glyph,
 * the name in serif with the kind stamp (the kind menu) and `v3 of 3` on
 * its baseline, one facts line under them, and the actions at the right —
 * Ask, Download, `···`, and in a window `Open as a page` and the close.
 */

/** A file as its window and its page read it. */
export type FileViewData = NonNullable<Awaited<ReturnType<typeof getFileView>>>

/** A file as Ask's scope chip: its chunks seed the turn. */
export const fileChip = (doc: {
  id: string
  filename: string
}): AskScopeChip => ({
  kind: 'file',
  id: doc.id,
  name: doc.filename,
  href: null,
})

/** Where it came from, after the size: `from Priya Raman by email, Tue 13 Oct`. */
function originWords(origin: FileViewData['origin'], today: string): string {
  const day = formatWeekday(origin.at, today)
  switch (origin.via) {
    case 'email':
      return origin.from === null
        ? `by email, ${day}`
        : `from ${origin.from} by email, ${day}`
    case 'lane':
      return `from ${laneName(origin.lane)}, ${day}`
    case 'upload':
      return origin.by === null
        ? `uploaded ${day}`
        : `uploaded by ${origin.by}, ${day}`
    case 'clip':
      return origin.by === null
        ? `clipped ${day}`
        : `clipped by ${origin.by}, ${day}`
  }
}

/**
 * The head's facts line: `14 pages · 4.2 MB · from Priya Raman by email,
 * Tue 13 Oct`. A person is named only when it is not the reader.
 */
export function fileFactsLine(
  view: Pick<FileViewData, 'pages' | 'origin'> & {
    doc: Pick<FileViewData['doc'], 'sizeBytes'>
  },
  today: string,
): string {
  return [
    view.pages === null
      ? null
      : `${String(view.pages)} page${view.pages === 1 ? '' : 's'}`,
    view.doc.sizeBytes ? formatBytes(view.doc.sizeBytes) : null,
    originWords(view.origin, today),
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** The kind as a solid ink stamp: `DECK ⌄`, and the menu that changes it. */
function KindStamp({ id, kind }: { id: string; kind: DocumentKind }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function setKind(next: DocumentKind) {
    if (next === kind) return
    setBusy(true)
    try {
      await setDocumentKind({ data: { documentId: id, kind: next } })
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change kind')
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-kind-stamp
          disabled={busy}
          aria-label={`Kind: ${DOCUMENT_KIND_LABELS[kind]}`}
          className="focus-ring stamp gap-1 pr-1"
        >
          {DOCUMENT_KIND_LABELS[kind]}
          <ChevronDown aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {KIND_ORDER.map((k) => (
          <DropdownMenuCheckboxItem
            key={k}
            checked={k === kind}
            onCheckedChange={() => void setKind(k)}
          >
            {DOCUMENT_KIND_LABELS[k]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** `Download` with its icon, or `Open source` for a clip with no file. */
function DownloadButton({ doc }: { doc: FileViewData['doc'] }) {
  const [busy, setBusy] = useState(false)
  if (blobless(doc))
    return doc.url === null ? null : (
      <Button variant="outline" asChild>
        <a
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          title={doc.url}
        >
          <icon.openOutside aria-hidden className="size-4" />
          Open source
        </a>
      </Button>
    )
  return (
    <Button
      variant="outline"
      pending={busy}
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void downloadDocument(doc.id, doc.blobSha === null).finally(() =>
          setBusy(false),
        )
      }}
    >
      <icon.download aria-hidden className="size-4" />
      Download
    </Button>
  )
}

export function FileHead({
  view,
  container,
  onAsk,
}: {
  view: FileViewData
  container: 'window' | 'page'
  /** After Ask opens on the file: the window steps aside for the dock. */
  onAsk?: () => void
}) {
  const router = useRouter()
  const { today } = useClock()
  const [versioning, setVersioning] = useState(false)
  const { doc } = view
  const inWindow = container === 'window'
  const Title = inWindow ? DialogTitle : 'h1'
  const Facts = inWindow ? DialogDescription : 'p'
  const page = `/files/${doc.id}`

  async function reRead() {
    try {
      const { queued } = await reExtractDocument({
        data: { documentId: doc.id },
      })
      // Pending either way and re-queueable; a down worker is said, not hidden.
      if (!queued) toast.message('Queued when the worker is back')
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not re-read')
    }
  }

  return (
    <header
      data-file-head
      className="flex h-24 shrink-0 items-center gap-4.5 border-b border-hairline bg-paper px-6"
    >
      <FileGlyphLarge type={fileType(doc)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <Title
            className={cn(
              'min-w-0 truncate font-serif text-page font-semibold',
              doc.replacedBy !== null && 'text-graphite',
            )}
          >
            {doc.filename}
          </Title>
          <KindStamp id={doc.id} kind={doc.kind} />
          {view.version === null ? null : (
            <span
              data-file-version
              className="shrink-0 mono text-label text-graphite"
            >
              v{view.version.at} of {view.version.of}
            </span>
          )}
        </div>
        <Facts
          data-file-facts
          className="truncate mono text-label text-graphite"
        >
          {fileFactsLine(view, today)}
        </Facts>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AskButton
          title="Ask with this file as the scope"
          onClick={() => {
            addMention(fileChip(doc))
            openAsk()
            onAsk?.()
          }}
        >
          Ask about this
        </AskButton>
        <DownloadButton doc={doc} />
        <MoreMenu
          variant="head"
          forceMenu
          label={`More for ${doc.filename}`}
          items={[
            ...(view.older.length === 0
              ? []
              : [
                  {
                    label: 'Newer version of…',
                    icon: <icon.version />,
                    opens: true,
                    onSelect: () => setVersioning(true),
                  },
                ]),
            {
              label: 'Re-read text',
              icon: <icon.update />,
              onSelect: () => void reRead(),
            },
            MENU_RULE,
            {
              label: 'Open in new tab',
              icon: <icon.openOutside />,
              href: page,
            },
            {
              label: 'Copy link',
              icon: <icon.copyLink />,
              copy: () => new URL(page, window.location.origin).href,
            },
          ]}
        />
        {inWindow ? (
          <WindowControls
            page={
              <OpenAsPage asChild>
                <Link to="/files/$fileId" params={{ fileId: doc.id }} />
              </OpenAsPage>
            }
          />
        ) : null}
      </div>
      {view.older.length === 0 ? null : (
        <NewerVersionDialog
          doc={doc}
          older={view.older}
          open={versioning}
          onOpenChange={setVersioning}
        />
      )}
    </header>
  )
}
