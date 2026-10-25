import { useEffect, useState } from 'react'
import { LabelHead } from '../ledger-section'
import { isFollowing, useFollow } from './file-row'
import type { RecordDocument } from './types'
import { listDocumentRevisions } from '#/lib/server-fns'
import type { RevisionRow } from '#/lib/server-fns'
import { dayMonth } from '#/lib/documents/files-tab'
import { storageLinkProvider } from '#/lib/documents/storage-link'
import { cn } from '#/lib/utils'

/**
 * A followed file's revisions in the viewer's sidebar, in place of
 * Versions: append-only, like the portfolio's event ledgers. Rows on rules,
 * newest first, the current one on bone, a mono time lane; no row can be
 * edited, deleted or restored. The foot names the provider's file and
 * holds Unfollow while it follows.
 */

/** `1aBcD…9xYz`: a provider id short enough for a lane, whole in its title. */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 5)}…${id.slice(-4)}` : id
}

/** What the head says on its right: the binding's state in one word. */
export function followWord(
  doc: Pick<RecordDocument, 'follow' | 'externalStatus'>,
): string {
  if (doc.externalStatus === 'gone') return 'gone'
  return isFollowing(doc) ? 'following' : 'stopped'
}

function rowLabel(row: RevisionRow): string {
  if (row.current) return `rev ${String(row.rev)} · current`
  return row.rev === 1 ? 'rev 1 · linked' : `rev ${String(row.rev)}`
}

export function RevisionLedger({
  doc,
  rows,
  busy = false,
  onUnfollow = null,
}: {
  doc: RecordDocument
  /** Newest first; null while they load. */
  rows: ReadonlyArray<RevisionRow> | null
  busy?: boolean
  /** Unfollow, offered while the file follows; null hides it. */
  onUnfollow?: (() => void) | null
}) {
  const count = rows?.length ?? doc.follow?.revisions ?? 1
  const where =
    (doc.externalUrl === null
      ? null
      : storageLinkProvider(doc.externalUrl)?.label) ?? 'Source'
  return (
    <section className="flex flex-col border-b border-rule">
      <LabelHead label={`Revisions · ${String(count)}`}>
        <span className="shrink-0 mono text-micro text-graphite">
          {followWord(doc)}
        </span>
      </LabelHead>
      <ol>
        {(rows ?? []).map((row) => (
          <li
            key={row.rev}
            data-revision={row.rev}
            className={cn(
              'flex h-8 items-center gap-3 border-b border-rule px-3',
              row.current && 'bg-bone',
            )}
          >
            <span className="min-w-0 flex-1 truncate text-ui">
              {rowLabel(row)}
            </span>
            {row.revisionId === null ? null : (
              <span
                title={row.revisionId}
                className="min-w-0 shrink truncate mono text-micro text-graphite"
              >
                {shortId(row.revisionId)}
              </span>
            )}
            <span className="tabular shrink-0 mono text-micro text-graphite">
              {dayMonth(row.at)} {row.at.slice(11, 16)}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex h-8 items-center justify-between gap-3 px-3">
        <span
          title={doc.externalId ?? undefined}
          className="min-w-0 truncate mono text-micro text-graphite"
        >
          {doc.externalId === null
            ? where
            : `${where} · ${shortId(doc.externalId)}`}
        </span>
        {onUnfollow === null ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={onUnfollow}
            className="focus-ring shrink-0 text-ui text-graphite hover:text-foreground hover:underline"
          >
            Unfollow
          </button>
        )}
      </div>
    </section>
  )
}

/** The ledger as the sidebar mounts it: fetched per file, again when a revision lands. */
export function FollowedRevisions({
  doc,
  recordId,
}: {
  doc: RecordDocument
  recordId: string
}) {
  const [rows, setRows] = useState<ReadonlyArray<RevisionRow> | null>(null)
  const follow = useFollow(recordId)
  const revisions = doc.follow?.revisions ?? 0
  useEffect(() => {
    let stale = false
    listDocumentRevisions({ data: { documentId: doc.id } }).then(
      (next) => {
        if (!stale) setRows(next)
      },
      () => undefined,
    )
    return () => {
      stale = true
    }
  }, [doc.id, revisions])
  return (
    <RevisionLedger
      doc={doc}
      rows={rows}
      busy={follow.busy}
      onUnfollow={isFollowing(doc) ? () => void follow.toggle(doc) : null}
    />
  )
}
