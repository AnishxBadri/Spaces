import { Link, useRouter } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { PickPopover } from '#/components/record/details-add'
import {
  DetailsAddRow,
  RailRow,
  RailSection,
} from '#/components/record/record-parts'
import { Switch } from '#/components/ui/switch'
import { spacePathLabel } from '#/lib/file-in-space'
import { recordPath } from '#/lib/record-path'
import {
  fileNoteAgainst,
  searchEntities,
  setNoteVisibility,
  tagIntoSpace,
  unfileNoteFrom,
  untagFromSpace,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import type { NoteData } from './note-head'

/** A live space the picker can offer, as `listSpaces` reads it. */
type SpaceChoice = {
  id: string
  name: string
  parentId: string | null
  companies: number
}

/** How many spaces the picker offers for one search. */
const SPACES_SHOWN = 8

/** Edits inside this long of the write are the writing, not an edit. */
const EDIT_AFTER_MS = 60_000

/**
 * The kind a row's end lane prints: an object's singular (`company`, a
 * custom object's own), else the entity kind (`space`, `note`, `document`).
 */
export function kindLane(row: {
  kind: string
  objectLabel?: string | null | undefined
}): string {
  return row.objectLabel ? row.objectLabel.toLowerCase() : row.kind
}

export type HistoryRow = { event: string; at: string; who: string | null }

/**
 * What the note's own rows can say about its life, newest first: written,
 * edited (past the first minute), landed from a tool, replaced. A kind change
 * is not logged anywhere, so it is not a row.
 */
export function noteHistory(note: NoteData): Array<HistoryRow> {
  const rows: Array<HistoryRow> = [
    { event: 'Written', at: note.createdAt, who: note.author },
  ]
  if (note.via !== null)
    rows.push({
      event: `Landed from ${note.via.tool}`,
      at: note.createdAt,
      who: note.via.author,
    })
  if (Date.parse(note.updatedAt) - Date.parse(note.createdAt) > EDIT_AFTER_MS)
    rows.push({ event: 'Edited', at: note.updatedAt, who: null })
  if (note.replacedBy !== null)
    rows.push({
      event: `Replaced by ${note.replacedBy.title}`,
      at: note.replacedBy.at,
      who: null,
    })
  // Rows at one instant: the later step first, so a landed note reads
  // landed above written.
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => Date.parse(b.row.at) - Date.parse(a.row.at) || b.i - a.i)
    .map(({ row }) => row)
}

/** A rail row's name: its page when it has one, the preview for a document. */
function RowName({
  row,
  dim = false,
  onPreview,
}: {
  row: { id: string; name: string; kind: string; objectSlug?: string | null }
  dim?: boolean
  onPreview: (id: string) => void
}) {
  const cls = cn(
    'focus-ring block truncate text-ui hover:underline',
    dim ? 'text-graphite' : 'text-foreground',
  )
  if (row.kind === 'document')
    return (
      <button
        type="button"
        className={cn(cls, 'text-left')}
        onClick={() => onPreview(row.id)}
      >
        {row.name}
      </button>
    )
  const href = recordPath(row)
  return href === null ? (
    <span className={cls}>{row.name}</span>
  ) : (
    <Link to={href} className={cls}>
      {row.name}
    </Link>
  )
}

/** The mono end lane: the kind, and an action after it when the row has one. */
function Lane({ children, end }: { children: string; end?: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-micro font-normal text-graphite">
      {children}
      {end}
    </span>
  )
}

function countLabel(label: string, n: number): string {
  return n > 0 ? `${label} · ${String(n)}` : label
}

/** Run a filing write, then let the loader say what the rail now is. */
function useWrite() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await action()
        await router.invalidate()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not file')
      } finally {
        setBusy(false)
      }
    },
    [router],
  )
  return { busy, run }
}

type FileHit = {
  id: string
  name: string
  lane: string
  target: 'record' | 'space'
}

/**
 * `+ File on…`: one picker for both lanes. Spaces are a tree of a few dozen,
 * so they are offered before anything is typed; records are unbounded, so
 * they come from a search. The two are different writes — `link(tagged_in)`
 * for a record, `entity_space` for a space — and the hit says which.
 * - `searchEntities`' `kinds` keeps spaces, notes and documents out of the
 *   record lane; `fileNoteAgainstProgram` refuses the same targets anyway.
 */
function FileOnPicker({
  note,
  allSpaces,
  run,
}: {
  note: NoteData
  allSpaces: ReadonlyArray<SpaceChoice>
  run: (action: () => Promise<unknown>) => Promise<void>
}) {
  const paths = useMemo(() => {
    const byId = new Map(allSpaces.map((s) => [s.id, s]))
    return new Map(allSpaces.map((s) => [s.id, spacePathLabel(s, byId)]))
  }, [allSpaces])
  const search = useCallback(
    async (q: string): Promise<ReadonlyArray<FileHit>> => {
      const term = q.trim().toLowerCase()
      // The note itself is unreachable through `kinds`, and held out here
      // anyway so the exclusion does not lean on an argument.
      const filed = new Set([
        note.id,
        ...note.filedAgainst.map((r) => r.id),
        ...note.spaces.map((s) => s.id),
      ])
      const spaces: Array<FileHit> = allSpaces
        .filter((s) => !filed.has(s.id))
        .map((s) => ({
          id: s.id,
          name: paths.get(s.id) ?? s.name,
          lane: 'space',
          target: 'space' as const,
        }))
        .filter((s) => s.name.toLowerCase().includes(term))
        .slice(0, SPACES_SHOWN)
      if (!term) return spaces
      const found = await searchEntities({
        data: { q: term, kinds: ['company', 'person', 'deal', 'custom'] },
      })
      const records: Array<FileHit> = found
        .filter((r) => !filed.has(r.id))
        .map((r) => ({
          id: r.id,
          name: r.name,
          lane: r.kind === 'custom' ? 'record' : r.kind,
          target: 'record' as const,
        }))
      return [...records, ...spaces]
    },
    [note, allSpaces, paths],
  )
  return (
    <PickPopover
      trigger={<DetailsAddRow>File on…</DetailsAddRow>}
      placeholder="File on a record or space…"
      eager
      search={search}
      lane={(hit) => hit.lane}
      onPick={(hit) =>
        run(() =>
          hit.target === 'space'
            ? tagIntoSpace({ data: { entityId: note.id, spaceId: hit.id } })
            : fileNoteAgainst({ data: { id: note.id, targetId: hit.id } }),
        )
      }
    />
  )
}

/**
 * Everything the note hangs from, records first and then spaces, each in
 * the order it was filed. Unfiling removes the filing alone: a body mention
 * of the same record is a different edge and stays.
 */
function FiledOn({
  note,
  allSpaces,
  onPreview,
}: {
  note: NoteData
  allSpaces: ReadonlyArray<SpaceChoice>
  onPreview: (id: string) => void
}) {
  const { busy, run } = useWrite()
  const n = note.filedAgainst.length + note.spaces.length
  const unfile = (name: string, action: () => Promise<unknown>) => (
    <button
      type="button"
      aria-label={`Unfile from ${name}`}
      disabled={busy}
      onClick={() => void run(action)}
      className="focus-ring text-graphite hover:text-foreground disabled:opacity-50"
    >
      ×
    </button>
  )
  return (
    <RailSection caps label={countLabel('Filed on', n)}>
      <div data-rail-section="filed-on" className="flex flex-col">
        {n === 0 ? <RailRow label="Not filed" value={null} /> : null}
        {note.filedAgainst.map((r) => (
          <RailRow
            key={r.id}
            label={<RowName row={r} onPreview={onPreview} />}
            value={
              <Lane
                end={unfile(r.name, () =>
                  unfileNoteFrom({ data: { id: note.id, targetId: r.id } }),
                )}
              >
                {kindLane(r)}
              </Lane>
            }
          />
        ))}
        {note.spaces.map((s) => (
          <RailRow
            key={s.id}
            label={
              <RowName
                row={{ ...s, kind: 'space' }}
                dim={s.archived}
                onPreview={onPreview}
              />
            }
            value={
              <Lane
                end={unfile(s.name, () =>
                  untagFromSpace({
                    data: { entityId: note.id, spaceId: s.id },
                  }),
                )}
              >
                {s.archived ? 'space · archived' : 'space'}
              </Lane>
            }
          />
        ))}
        <FileOnPicker note={note} allSpaces={allSpaces} run={run} />
      </div>
    </RailSection>
  )
}

/** A derived list — mentions out, mentions in: name and kind, no controls. */
function LinkList({
  name,
  label,
  rows,
  onPreview,
}: {
  name: string
  label: string
  rows: ReadonlyArray<{
    id: string
    name: string
    kind: string
    objectSlug?: string | null
    objectLabel?: string | null
  }>
  onPreview: (id: string) => void
}) {
  if (rows.length === 0) return null
  return (
    <RailSection caps label={countLabel(label, rows.length)}>
      <div data-rail-section={name} className="flex flex-col">
        {rows.map((r) => (
          <RailRow
            key={r.id}
            label={<RowName row={r} onPreview={onPreview} />}
            value={<Lane>{kindLane(r)}</Lane>}
          />
        ))}
      </div>
    </RailSection>
  )
}

/**
 * Who may read the note. The author holds the switch; any other reader sees
 * the words alone.
 */
function Visibility({ note }: { note: NoteData }) {
  const router = useRouter()
  const [isPrivate, setIsPrivate] = useState(note.isPrivate)
  const [pending, setPending] = useState(false)
  const words = isPrivate ? 'Only you' : 'Shared with the workspace'

  async function toggle(shared: boolean) {
    setPending(true)
    try {
      await setNoteVisibility({
        data: { id: note.id, visibility: shared ? 'shared' : 'private' },
      })
      setIsPrivate(!shared)
      // The head's stamp and meta line read the loader's copy.
      await router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change that')
    } finally {
      setPending(false)
    }
  }

  return (
    <RailSection caps label="Visibility">
      <div
        data-rail-section="visibility"
        className="flex h-row items-center border-t border-rule"
      >
        {note.isMine ? (
          <Switch
            checked={!isPrivate}
            disabled={pending}
            title="Private notes are read by you alone"
            onCheckedChange={(shared) => void toggle(shared)}
            className="text-ui text-foreground"
          >
            {words}
          </Switch>
        ) : (
          <span className="text-ui text-foreground">{words}</span>
        )}
      </div>
    </RailSection>
  )
}

function History({ note }: { note: NoteData }) {
  const { today } = useClock()
  return (
    <RailSection caps label="History">
      <div data-rail-section="history" className="flex flex-col">
        {noteHistory(note).map((h) => (
          <RailRow
            key={h.event}
            label={h.event}
            value={
              <span className="text-micro font-normal text-graphite">
                {[formatDay(h.at, today), h.who]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </span>
            }
          />
        ))}
      </div>
    </RailSection>
  )
}

/**
 * The note's record rail, right of the body on bone: where it is filed, what
 * it mentions, what mentions it, who may read it, and its history. Below
 * `md` it stacks under the body.
 */
export function NoteRail({
  note,
  allSpaces,
  onPreview,
}: {
  note: NoteData
  allSpaces: ReadonlyArray<SpaceChoice>
  onPreview: (id: string) => void
}) {
  return (
    <aside
      aria-label="Details"
      data-note-rail
      className="flex w-full shrink-0 flex-col border-t border-hairline bg-bone md:sticky md:top-12 md:max-h-[calc(100dvh-3rem)] md:w-72 md:overflow-y-auto md:border-t-0 md:border-l"
    >
      <FiledOn note={note} allSpaces={allSpaces} onPreview={onPreview} />
      <LinkList
        name="mentions"
        label="Mentions"
        rows={note.mentions}
        onPreview={onPreview}
      />
      <LinkList
        name="mentioned-in"
        label="Mentioned in"
        rows={note.backlinks.map((b) => ({
          id: b.fromId,
          name: b.name,
          kind: b.kind,
        }))}
        onPreview={onPreview}
      />
      <Visibility note={note} />
      <History note={note} />
    </aside>
  )
}
