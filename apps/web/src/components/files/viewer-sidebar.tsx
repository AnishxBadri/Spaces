import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { ChevronDown, Email, icon } from '../icons'
import { ProviderMark, brandOf } from '../provider-mark'
import { FileUnderButton, FilingKindIcon, FilingName } from './file-under'
import { useOpenFile } from './file-window-nav'
import { FollowedRevisions } from './revision-ledger'
import { useKeepCopy } from './keep-copy'
import type { KeepCopy } from './keep-copy'
import type { FileViewData } from './file-head'
import type { RemoteBytes } from '#/lib/documents/files-tab'
import type { FileUnderOption } from '#/lib/documents/file-under'
import type { FileOrigin, RailVersion } from '#/lib/documents/file-view'
import {
  fileDocument,
  reExtractDocument,
  unfileDocument,
} from '#/lib/server-fns'
import { recordPath } from '#/lib/record-path'
import { formatDay, formatWhen } from '@spaces/core/format'
import { cn } from '#/lib/utils'
import { useClock } from '#/components/clock'

/**
 * The viewer's rail, the same in the window and on the page: a notice when
 * the text could not be read, `Filed under` (one row per record or space,
 * each with its own unfile, and `+ File under…`), `Versions` as a timeline
 * when there is more than one (a followed file's revisions instead), the
 * notes that mention it, and `Source`. No checksum, no kind (the head's
 * stamp), no text line on a healthy file.
 */

/** A section of the rail: a mono caps head over its body, a rule under it. */
function Section({
  label,
  className,
  children,
}: {
  label: string
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-2 border-b border-rule px-4 pt-3 pb-4',
        className,
      )}
    >
      <h3 className="label-caps text-graphite">{label}</h3>
      {children}
    </section>
  )
}

export function FileViewerSidebar({
  view,
  container,
}: {
  view: FileViewData
  /** Where a version opens: in this window's place, or as its page. */
  container: 'window' | 'page'
}) {
  const { doc } = view
  const keeper = useKeepCopy()
  return (
    <>
      {doc.extractionStatus === 'failed' ? (
        <TextNotice documentId={doc.id} />
      ) : null}
      <FiledUnder documentId={doc.id} filings={view.filings} />
      {doc.follow === null ? (
        view.versions.length > 1 ? (
          <Versions versions={view.versions} container={container} />
        ) : null
      ) : (
        <FollowedRevisions
          doc={doc}
          // Unfollow needs no record; a file with no record passes itself.
          recordId={doc.filedIn.find((e) => e.kind === 'record')?.id ?? doc.id}
        />
      )}
      <MentionedIn notes={view.mentionedIn} />
      <Source view={view} keeper={keeper} />
    </>
  )
}

/** `■ Text could not be read · Try again`, heading the rail. */
function TextNotice({ documentId }: { documentId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <div
      data-text-notice
      className="flex h-row shrink-0 items-center gap-2 border-b border-rule px-4"
    >
      <span aria-hidden className="size-2 shrink-0 bg-destructive" />
      <span className="min-w-0 flex-1 truncate text-ui">
        Text could not be read
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          reExtractDocument({ data: { documentId } })
            .then(() => router.invalidate())
            .catch((err: unknown) => {
              toast.error(
                err instanceof Error ? err.message : 'Could not try again',
              )
            })
            .finally(() => setBusy(false))
        }}
        className="focus-ring shrink-0 text-ui underline underline-offset-2 hover:text-graphite"
      >
        {busy ? 'Trying…' : 'Try again'}
      </button>
    </div>
  )
}

/** Rows shown before the block folds to `n more`. */
const FOLD_AT = 5

/** The kind word at a row's end: `Company`, `Space`, a custom object's singular. */
export function filingKindWord(
  option: Pick<FileUnderOption, 'kind' | 'object'>,
): string {
  if (option.object !== null) return option.object.singular
  switch (option.kind) {
    case 'company':
      return 'Company'
    case 'person':
      return 'Person'
    case 'deal':
      return 'Deal'
    case 'space':
      return 'Space'
    default:
      return 'Record'
  }
}

function FiledUnder({
  documentId,
  filings,
}: {
  documentId: string
  filings: ReadonlyArray<FileUnderOption>
}) {
  const router = useRouter()
  const [unfolded, setUnfolded] = useState(false)
  const [busy, setBusy] = useState(false)
  const shown = unfolded ? filings : filings.slice(0, FOLD_AT)
  const folded = filings.length - shown.length

  // No dialog: the filing goes, and the toast's Undo files it again through
  // the same write as any filing, so a Gmail-held file keeps its copy.
  async function unfile(option: FileUnderOption) {
    setBusy(true)
    try {
      await unfileDocument({ data: { documentId, target: option.target } })
      await router.invalidate()
      toast(`Unfiled from ${option.name}`, {
        action: {
          label: 'Undo',
          onClick: () =>
            void fileDocument({ data: { documentId, target: option.target } })
              .then(() => router.invalidate())
              .catch((err: unknown) => {
                toast.error(
                  err instanceof Error ? err.message : 'Could not file it',
                )
              }),
        },
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not unfile it')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section label={`Filed under · ${String(filings.length)}`}>
      {filings.length === 0 ? null : (
        <div className="flex flex-col border border-hairline bg-paper">
          {shown.map((option) => (
            <FiledRow
              key={`${option.target.kind}-${option.target.entityId}`}
              option={option}
              busy={busy}
              onUnfile={() => void unfile(option)}
            />
          ))}
          {folded > 0 ? (
            <button
              type="button"
              onClick={() => setUnfolded(true)}
              className="focus-ring flex h-7.5 shrink-0 items-center gap-2 px-2.5 text-left text-ui text-graphite hover:bg-bone hover:text-foreground"
            >
              <span className="flex-1">{`${String(folded)} more`}</span>
              <ChevronDown aria-hidden className="size-4" />
            </button>
          ) : null}
        </div>
      )}
      <FileUnderButton documentId={documentId} />
    </Section>
  )
}

/**
 * One filing: the kind's icon in a solid cell (ink for a record, pine for a
 * space), the name, the kind word at the end. Under the pointer the row
 * turns bone and the end becomes the minus cell that unfiles it.
 */
function FiledRow({
  option,
  busy,
  onUnfile,
}: {
  option: FileUnderOption
  busy: boolean
  onUnfile: () => void
}) {
  const isSpace = option.target.kind === 'space'
  // A custom record routes through its object's slug; a kind with no page
  // reads as plain text rather than a broken link.
  const href = recordPath({
    kind: option.kind,
    id: option.target.entityId,
    objectSlug: option.object?.slug ?? null,
  })
  return (
    <div
      data-filing={option.target.entityId}
      className="group relative flex h-row shrink-0 items-center border-b border-rule last:border-b-0 hover:bg-bone has-focus-visible:bg-bone"
    >
      <span
        className={cn(
          'flex w-9 shrink-0 items-center justify-center self-stretch',
          isSpace ? 'bg-primary' : 'bg-hairline',
        )}
      >
        <FilingKindIcon option={option} className="text-paper" />
      </span>
      <span className="flex min-w-0 flex-1 px-2.5">
        {href === null ? (
          <FilingName option={option} strong />
        ) : (
          <Link
            to={href}
            className="focus-ring flex min-w-0 flex-1 hover:underline"
          >
            <FilingName option={option} strong />
          </Link>
        )}
      </span>
      <span className="shrink-0 pr-2.5 mono text-field tracking-[0.08em] text-graphite uppercase group-hover:invisible group-has-focus-visible:invisible">
        {filingKindWord(option)}
      </span>
      <button
        type="button"
        aria-label={`Unfile from ${option.name}`}
        disabled={busy}
        onClick={onUnfile}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center border-l border-rule bg-bone text-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-hairline hover:text-paper focus-visible:bg-hairline focus-visible:text-paper focus-visible:opacity-100"
      >
        <icon.unfile aria-hidden className="size-4" />
      </button>
    </div>
  )
}

/** The lanes that bring files, as the head's facts line names them. */
const LANE_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  'google-drive': 'Drive',
  'google-calendar': 'Google Calendar',
  'core.mailbox': 'Forwarding',
}

/** A capability as a reader says it: `Gmail`, else its id in sentence case. */
export function laneName(capability: string): string {
  return (
    LANE_NAMES[capability] ??
    capability.charAt(0).toUpperCase() + capability.slice(1)
  )
}

/** A lane by its provider's full name, as a version's line says it. */
const PROVIDER_NAMES: Readonly<Partial<Record<string, string>>> = {
  'google-drive': 'Google Drive',
}

/** The last folder of a provider's path: `My Drive / Data room` is `Data room`. */
function lastFolder(path: string | null): string | null {
  if (path === null) return null
  return (
    path
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .at(-1) ?? null
  )
}

/**
 * Who brought a version and how, under its name: `Priya Raman, by email`,
 * `Uploaded by you`, `Google Drive, Data room`.
 */
export function versionByLine(origin: FileOrigin): string {
  switch (origin.via) {
    case 'email':
      return `${origin.from ?? 'You'}, by email`
    case 'lane':
      return [
        PROVIDER_NAMES[origin.lane] ?? laneName(origin.lane),
        lastFolder(origin.path),
      ]
        .filter((part) => part !== null)
        .join(', ')
    case 'upload':
      return `Uploaded by ${origin.by ?? 'you'}`
    case 'clip':
      return `Saved by ${origin.by ?? 'you'}`
  }
}

/**
 * The replace chain as a timeline, newest first: a mono date, a 1px ink
 * line with a square node per version (solid for the open one), then the
 * version's number, `This one` or its filename, its pages and who brought
 * it. Another version opens in the viewer in this one's place.
 */
function Versions({
  versions,
  container,
}: {
  versions: ReadonlyArray<RailVersion>
  container: 'window' | 'page'
}) {
  const { today } = useClock()
  const openInWindow = useOpenFile()
  const navigate = useNavigate()
  const open = (id: string) => {
    if (container === 'window') openInWindow(id)
    else void navigate({ to: '/files/$fileId', params: { fileId: id } })
  }
  return (
    <Section label={`Versions · ${String(versions.length)}`} className="pb-1.5">
      <ol className="flex flex-col">
        {versions.map((v, i) => {
          const first = i === 0
          const last = i === versions.length - 1
          const body = (
            <>
              <span
                className={cn(
                  'w-10.5 shrink-0 text-right mono text-micro leading-5',
                  v.current ? 'text-foreground' : 'text-graphite',
                )}
              >
                {formatDay(v.at, today)}
              </span>
              <span
                aria-hidden
                className="flex w-2.75 shrink-0 flex-col items-center"
              >
                <span
                  className={cn(
                    'h-1.25 w-px shrink-0',
                    !first && 'bg-hairline',
                  )}
                />
                <span
                  className={cn(
                    'size-2.75 shrink-0 border border-hairline',
                    v.current ? 'bg-hairline' : 'bg-paper',
                  )}
                />
                <span className={cn('w-px flex-1', !last && 'bg-hairline')} />
              </span>
              <span
                className={cn(
                  'flex min-w-0 flex-1 flex-col',
                  last ? 'pb-2.5' : 'pb-3.5',
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'shrink-0 mono text-label leading-5 font-semibold',
                      v.current ? 'text-foreground' : 'text-graphite',
                    )}
                  >
                    {`v${String(versions.length - i)}`}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-ui group-hover/version:underline',
                      v.current && 'font-medium',
                    )}
                  >
                    {v.current ? 'This one' : v.name}
                  </span>
                  {v.pages === null ? null : (
                    <span className="shrink-0 mono text-micro leading-5 text-graphite">
                      {`${String(v.pages)} pp`}
                    </span>
                  )}
                </span>
                <span className="truncate text-label text-graphite">
                  {versionByLine(v.origin)}
                </span>
              </span>
            </>
          )
          return (
            <li
              key={v.id}
              data-version={v.id}
              {...(v.current ? { 'data-current': true } : {})}
            >
              {v.current ? (
                <div className="flex gap-2.5">{body}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => open(v.id)}
                  className="group/version focus-ring flex w-full gap-2.5 text-left"
                >
                  {body}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </Section>
  )
}

/** The notes that mention the file, the reader's own private ones included. */
function MentionedIn({ notes }: { notes: FileViewData['mentionedIn'] }) {
  const { now } = useClock()
  if (notes.length === 0) return null
  return (
    <Section label={`Mentioned in · ${String(notes.length)}`}>
      {notes.map((m) => (
        <div
          key={m.id}
          className="flex min-h-7 items-center justify-between gap-3"
        >
          <Link
            to="/notes/$noteId"
            params={{ noteId: m.id }}
            className="focus-ring min-w-0 truncate text-ui hover:underline"
          >
            {m.name}
          </Link>
          <span className="shrink-0 mono text-micro text-graphite">
            {formatWhen(m.at, now)}
          </span>
        </div>
      ))}
    </Section>
  )
}

const SOURCE_ROW = 'flex min-w-0 items-center gap-2 text-ui'
const SOURCE_LINK =
  'focus-ring min-w-0 truncate underline underline-offset-2 hover:text-graphite'

/**
 * One linked row: the email's subject (the Email page opens it), the
 * provider's folder path (the provider's own page), the link's address, or
 * `Uploaded from a computer`. An attachment whose mailbox is disconnected
 * says so under it.
 */
function Source({ view, keeper }: { view: FileViewData; keeper: KeepCopy }) {
  const { source } = view
  return (
    <Section label="Source" className="border-b-0 pb-3.5">
      {source.via === 'email' ? (
        <div className={SOURCE_ROW}>
          <Email aria-hidden className="size-4 shrink-0 text-graphite" />
          <Link
            to="/email"
            search={{ id: source.id }}
            data-source-email
            className={SOURCE_LINK}
          >
            {source.subject}
          </Link>
        </div>
      ) : source.via === 'lane' ? (
        <LaneSource source={source} />
      ) : source.via === 'link' ? (
        <div className={SOURCE_ROW}>
          <icon.copyLink
            aria-hidden
            className="size-4 shrink-0 text-graphite"
          />
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className={SOURCE_LINK}
          >
            {source.url}
          </a>
        </div>
      ) : (
        <div className={SOURCE_ROW}>
          <icon.upload aria-hidden className="size-4 shrink-0 text-graphite" />
          <span className="min-w-0 truncate">Uploaded from a computer</span>
        </div>
      )}
      {/* While the file is still in Gmail the body says so, with Keep a copy. */}
      {view.doc.remoteBytes === 'gone' ? (
        <KeepCopyLine doc={view.doc} keeper={keeper} />
      ) : null}
    </Section>
  )
}

function LaneSource({
  source,
}: {
  source: Extract<FileViewData['source'], { via: 'lane' }>
}) {
  const brand = brandOf(source.lane)
  const words =
    source.path ?? PROVIDER_NAMES[source.lane] ?? laneName(source.lane)
  return (
    <div className={SOURCE_ROW}>
      {brand === null ? (
        <icon.openOutside
          aria-hidden
          className="size-4 shrink-0 text-graphite"
        />
      ) : (
        <ProviderMark brand={brand} className="size-4 shrink-0" />
      )}
      {source.href === null ? (
        <span className="min-w-0 truncate">{words}</span>
      ) : (
        <a
          href={source.href}
          target="_blank"
          rel="noreferrer"
          className={SOURCE_LINK}
        >
          {words}
        </a>
      )}
    </div>
  )
}

/**
 * Source's last word on an email attachment whose file stays in the
 * mailbox: `File in Gmail, text here · Keep a copy`, or the text alone once
 * the mailbox is disconnected. Nothing for any other file.
 */
export function KeepCopyLine({
  doc,
  keeper,
}: {
  doc: { readonly id: string; readonly remoteBytes?: RemoteBytes }
  keeper: KeepCopy
}) {
  if (doc.remoteBytes === 'linked')
    return (
      <p data-source-keep className="mono text-micro text-graphite">
        File in Gmail, text here ·{' '}
        <button
          type="button"
          disabled={keeper.busy}
          onClick={() => void keeper.keep(doc.id)}
          className="focus-ring underline hover:text-foreground"
        >
          {keeper.busy ? 'Keeping a copy…' : 'Keep a copy'}
        </button>
      </p>
    )
  if (doc.remoteBytes === 'gone')
    return (
      <p data-source-keep className="mono text-micro text-graphite">
        Gmail disconnected, text here
      </p>
    )
  return null
}
