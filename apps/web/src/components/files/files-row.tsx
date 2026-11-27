import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { MouseEvent } from 'react'
import { toast } from 'sonner'
import { Email, Folder, Link as LinkGlyph, icon } from '../icons'
import type { IconComponent } from '../icons'
import { AskMark } from '../ui/ask-control'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useClock } from '../clock'
import { FileGlyph } from './file-glyph'
import { FileUnderPanel, FilingName } from './file-under'
import { FileNameLink } from './file-window-nav'
import { ShelfRowMenu } from './shelf-row-menu'
import { laneName } from './viewer-sidebar'
import type { FilesLedgerRow, FilesSource } from '#/lib/documents/files-ledger'
import { factsLine, fileDay } from '#/lib/documents/files-ledger-view'
import { fileType } from '#/lib/documents/files-tab'
import { recordPath } from '#/lib/record-path'
import {
  fileDocument,
  reExtractDocument,
  unfileDocument,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * One file on the Files page, 56px and two lines: the glyph, the name over
 * the first line of its text, then fixed lanes for its facts, where it is
 * filed, where it came from and the day, and the `···` on hover.
 * - A click anywhere on the row opens the file's window; the name is the
 *   link (Cmd-click opens its page). A control in the row is its own click.
 * - Unfiled, the filed-under lane offers `File under <guess> ↵` and
 *   `Other…`, or `File under…` when the file names no record.
 * - Narrower panes drop the lanes from the right of the name inward: the
 *   facts below `xl`, the source below `lg`, the filing below `md`, where
 *   the row's `···` still files it.
 * - Under a search, a file whose text matched reads the match's page and
 *   the line around it, and the facts lane how many more places matched.
 */
export function FilesRow({
  row,
  onOpen,
  band,
}: {
  row: FilesLedgerRow
  /** Opens the file's window over the page (at the hit's page). */
  onOpen: () => void
  /** The record or space whose band it stands in: its lane leaves it out. */
  band?: string | undefined
}) {
  const { now } = useClock()

  function openFromRow(e: MouseEvent<HTMLLIElement>) {
    // A window or menu the row opened is portalled out of it but still
    // bubbles here through React; a control inside the row is its own click.
    if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target))
      return
    if (e.target.closest('a, button, input') !== null) return
    onOpen()
  }

  return (
    <li
      data-row
      data-file-row={row.id}
      onClick={openFromRow}
      className="group flex h-14 cursor-pointer items-center gap-3 border-b border-rule px-(--inset) transition-colors duration-100 ease-out-quart hover:bg-bone"
    >
      <FileGlyph type={fileType(row)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <FileNameLink
            id={row.id}
            onOpen={onOpen}
            title={`Open ${row.filename}`}
            className="focus-ring min-w-0 truncate text-ui text-foreground hover:underline"
          >
            {row.filename}
          </FileNameLink>
          {row.versionAt === null ? null : (
            <span
              data-file-version
              className="shrink-0 mono text-micro text-graphite"
            >
              v{row.versionAt}
            </span>
          )}
        </span>
        {row.hit !== null && row.extractionStatus === 'done' ? (
          <HitLine hit={row.hit} />
        ) : (
          <TextLine row={row} />
        )}
      </div>
      {row.hit === null ? (
        <span
          data-file-facts
          className="hidden w-47.5 shrink-0 truncate mono text-micro text-graphite xl:block"
        >
          {factsLine(row)}
        </span>
      ) : (
        <span
          data-file-more
          className="hidden w-47.5 shrink-0 truncate mono text-micro text-graphite md:block"
        >
          {row.hit.more}
        </span>
      )}
      <span className="hidden w-55 shrink-0 items-center gap-2 md:flex">
        <FiledLane row={row} band={band} />
      </span>
      <span className="hidden w-45 shrink-0 items-center gap-2 lg:flex">
        <SourceLane source={row.source} />
      </span>
      <time
        dateTime={row.createdAt}
        className="w-14 shrink-0 text-right mono text-micro whitespace-nowrap text-graphite"
      >
        {fileDay(row.createdAt, now)}
      </time>
      <span className="flex w-6 shrink-0 justify-end">
        <ShelfRowMenu doc={row} onOpen={onOpen} />
      </span>
    </li>
  )
}

/**
 * The line under the name: the file's first line of text, the working
 * mark while it is being read, or why it could not be read with
 * `Read again`.
 */
function TextLine({ row }: { row: FilesLedgerRow }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  if (row.extractionStatus === 'pending')
    return (
      <span
        data-file-line="reading"
        className="flex h-4 items-center gap-2 text-label text-graphite"
      >
        <AskMark working />
        Reading text
      </span>
    )

  if (row.extractionStatus === 'failed') {
    async function readAgain() {
      setBusy(true)
      try {
        const { queued } = await reExtractDocument({
          data: { documentId: row.id },
        })
        // Pending either way and re-queueable; a down worker is said.
        if (!queued) toast.message('Queued when the worker is back')
        await router.invalidate()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not read it')
      } finally {
        setBusy(false)
      }
    }
    const reason =
      row.extractionError === null || row.extractionError.trim() === ''
        ? 'Text not read'
        : `Text not read · ${row.extractionError.trim()}`
    return (
      <span
        data-file-line="failed"
        className="flex h-4 min-w-0 items-center gap-2 text-label"
      >
        <span aria-hidden className="size-1.5 shrink-0 bg-destructive" />
        <span title={reason} className="min-w-0 truncate text-destructive">
          {reason}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void readAgain()}
          className="focus-ring shrink-0 rounded-md text-foreground underline underline-offset-2 hover:text-graphite disabled:text-graphite"
        >
          Read again
        </button>
      </span>
    )
  }

  return row.firstLine === null ? null : (
    <span
      data-file-line="text"
      className="min-w-0 truncate text-label text-graphite"
    >
      {row.firstLine}
    </span>
  )
}

/**
 * A search hit: the page in mono (`p. 5`, a sheet's name), then the line
 * around the match with the match in medium.
 */
function HitLine({ hit }: { hit: NonNullable<FilesLedgerRow['hit']> }) {
  return (
    <span
      data-file-line="hit"
      className="flex h-4 min-w-0 items-baseline gap-2 text-label"
    >
      {hit.label === null ? null : (
        <span className="shrink-0 mono text-micro text-foreground">
          {hit.label}
        </span>
      )}
      <span className="min-w-0 truncate text-graphite">
        {hit.before}
        <mark className="bg-transparent font-medium text-foreground">
          {hit.match}
        </mark>
        {hit.after}
      </span>
    </span>
  )
}

/**
 * Where it is filed: its first record or space and a mono `+n` for the
 * rest, leaving out the band's own; unfiled, the guess as one button and
 * `Other…`, or `File under…`.
 */
function FiledLane({
  row,
  band,
}: {
  row: FilesLedgerRow
  band: string | undefined
}) {
  if (row.unfiled)
    return row.guess === null ? (
      <FileUnderPopover documentId={row.id} className={FILE_UNDER_BUTTON}>
        File under…
      </FileUnderPopover>
    ) : (
      <>
        <GuessButton documentId={row.id} guess={row.guess} />
        <FileUnderPopover
          documentId={row.id}
          className="focus-ring shrink-0 rounded-md text-label text-graphite hover:text-foreground"
        >
          Other…
        </FileUnderPopover>
      </>
    )

  const records = row.records.filter((r) => r.id !== band)
  const spaces = row.spaces.filter((sp) => sp.id !== band)
  const record = records.at(0)
  const space = spaces.at(0)
  const rest = records.length + spaces.length - 1
  const href =
    record !== undefined
      ? recordPath(record)
      : space !== undefined
        ? `/spaces/${space.id}`
        : null
  const name =
    record !== undefined ? (
      <span className="min-w-0 truncate text-label">{record.name}</span>
    ) : space !== undefined ? (
      <FilingName option={space} />
    ) : null
  return (
    <>
      {href === null ? (
        name
      ) : (
        <Link
          to={href}
          className="focus-ring flex min-w-0 text-label text-foreground hover:underline"
        >
          {name}
        </Link>
      )}
      {rest > 0 ? (
        <span className="shrink-0 mono text-micro text-graphite">+{rest}</span>
      ) : null}
    </>
  )
}

const FILE_UNDER_BUTTON =
  'focus-ring flex h-7 min-w-0 shrink items-center gap-2 rounded-md border border-hairline bg-paper px-2.5 text-ui text-foreground transition-colors duration-100 ease-out-quart hover:bg-bone'

/**
 * `File under Flent ↵`: one press files the row under the record its text
 * names, and the toast's Undo unfiles it again.
 */
function GuessButton({
  documentId,
  guess,
}: {
  documentId: string
  guess: NonNullable<FilesLedgerRow['guess']>
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function file() {
    setBusy(true)
    const target = guess.target
    try {
      await fileDocument({ data: { documentId, target } })
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not file it')
      setBusy(false)
      return
    }
    toast(`Filed under ${guess.name}`, {
      action: {
        label: 'Undo',
        onClick: () =>
          void unfileDocument({ data: { documentId, target } })
            .then(() => router.invalidate())
            .catch((err: unknown) => {
              toast.error(
                err instanceof Error ? err.message : 'Could not unfile it',
              )
            }),
      },
    })
  }

  return (
    <button
      type="button"
      data-file-guess={guess.target.entityId}
      disabled={busy}
      onClick={() => void file()}
      className={cn(FILE_UNDER_BUTTON, 'pr-1.5')}
    >
      <span className="min-w-0 truncate">File under {guess.name}</span>
      <span
        aria-hidden
        className="flex h-4 shrink-0 items-center rounded-md border border-rule px-0.75 mono text-field text-graphite"
      >
        ↵
      </span>
    </button>
  )
}

/** A button that opens the `File under…` popover over the row. */
function FileUnderPopover({
  documentId,
  className,
  children,
}: {
  documentId: string
  className: string
  children: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-file-under className={className}>
          <span className="min-w-0 truncate">{children}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-85 p-0">
        {open ? <FileUnderPanel documentId={documentId} /> : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Where it came from: the sender, the provider's folder, the site, or
 * `Uploaded`. A person is named only when it is not the reader.
 */
function SourceLane({ source }: { source: FilesSource }) {
  const [Mark, words] = sourceWords(source)
  return (
    <>
      <Mark aria-hidden className="size-4 shrink-0 text-graphite" />
      <span
        data-file-source={source.via}
        className="min-w-0 truncate text-label text-graphite"
      >
        {words}
      </span>
    </>
  )
}

/** The lanes that bring email rather than files from a folder. */
const MAIL_LANES: ReadonlySet<string> = new Set(['gmail', 'core.mailbox'])

function sourceWords(source: FilesSource): [IconComponent, string] {
  switch (source.via) {
    case 'email':
      return [Email, source.from ?? source.mailbox ?? 'Email']
    case 'lane':
      return MAIL_LANES.has(source.lane)
        ? [Email, laneName(source.lane)]
        : [Folder, source.path ?? laneName(source.lane)]
    case 'link':
      return [LinkGlyph, source.site]
    case 'upload':
      return [icon.upload, source.by ?? 'Uploaded']
  }
}
