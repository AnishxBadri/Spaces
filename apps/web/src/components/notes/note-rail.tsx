import { Link, useRouter } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { toast } from 'sonner'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { KindIcon } from '#/components/kind-icon'
import type { KindOf } from '#/components/kind-icon'
import { PickPopover } from '#/components/record/details-add'
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
 * The rail's 80px label lane: 8px over a 16px line, so a label's first line
 * sits on the centre of the 32px value row beside it.
 */
const LABEL_LANE = 'w-20 shrink-0 py-2'

export type HistoryRow = { event: string; at: string; who: string | null }

/**
 * The note's life as its own rows record it: `Written` (the day and who),
 * then `Edited` (the day) once an edit lands past the first minute. Where it
 * landed from and what replaced it are the head's meta line.
 */
export function noteHistory(note: NoteData): Array<HistoryRow> {
  const rows: Array<HistoryRow> = [
    { event: 'Written', at: note.createdAt, who: note.author },
  ]
  if (Date.parse(note.updatedAt) - Date.parse(note.createdAt) > EDIT_AFTER_MS)
    rows.push({ event: 'Edited', at: note.updatedAt, who: null })
  return rows
}

/** A rail record: what its name links to and what its icon reads. */
type RailRecord = KindOf & {
  id: string
  name: string
  objectSlug?: string | null
}

/** A rail row's name: its page when it has one, the preview for a document. */
function RowName({
  row,
  dim = false,
  onPreview,
}: {
  row: RailRecord
  dim?: boolean
  onPreview: (id: string) => void
}) {
  const cls = cn(
    'focus-ring min-w-0 truncate text-ui hover:underline',
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

/**
 * A group of the rail: its rows, one rule under it. Rules fall between
 * groups, never between the values of one.
 */
function LaneGroup({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div
      data-rail-section={name}
      className="flex flex-col border-b border-rule py-1 last:border-b-0"
    >
      {children}
    </div>
  )
}

/** One labelled row: the label in the 80px lane, its values stacked right. */
function LaneRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        data-rail-label
        className={cn(LABEL_LANE, 'text-label break-words text-graphite')}
      >
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}

/** One 32px value. */
function Value({ children }: { children: ReactNode }) {
  return (
    <div data-rail-value className="flex h-8 min-w-0 items-center gap-2">
      {children}
    </div>
  )
}

/** A record value: its kind icon, its name, and an action at the end. */
function RecordValue({
  row,
  dim,
  end,
  onPreview,
}: {
  row: RailRecord
  dim?: boolean
  end?: ReactNode
  onPreview: (id: string) => void
}) {
  return (
    <Value>
      <KindIcon of={row} />
      <RowName row={row} dim={dim ?? false} onPreview={onPreview} />
      {end === undefined ? null : (
        <span className="ml-auto flex shrink-0 items-center gap-2">{end}</span>
      )}
    </Value>
  )
}

/**
 * The value a group ends on: `+ File on…` in graphite, the `+` in the icon's
 * lane. A plain button that spreads its props, so a popover trigger can hand
 * it its own.
 */
function AddValue({ children, className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-rail-value
      {...props}
      className={cn(
        'focus-ring flex h-8 w-full min-w-0 items-center gap-2 text-left text-ui text-graphite transition-colors hover:text-foreground',
        className,
      )}
    >
      <span className="w-4 shrink-0 text-center mono text-ui text-primary">
        +
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
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
  of: KindOf
  target: 'record' | 'space'
}

/**
 * `+ File on…`: one picker for both lanes. Spaces are a tree of a few dozen,
 * so they are offered before anything is typed; records are unbounded, so
 * they come from a search. The two are different writes — `link(tagged_in)`
 * for a record, `entity_space` for a space — and the hit says which.
 * - `searchEntities`' `kinds` keeps spaces, notes and documents out of the
 *   record lane; `fileNoteAgainstProgram` refuses the same targets anyway.
 * - Each hit leads on its kind icon.
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
          of: { kind: 'space' },
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
          of: { kind: r.kind },
          target: 'record' as const,
        }))
      return [...records, ...spaces]
    },
    [note, allSpaces, paths],
  )
  return (
    <PickPopover
      trigger={<AddValue>File on…</AddValue>}
      placeholder="File on a record or space…"
      eager
      search={search}
      lead={(hit) => <KindIcon of={hit.of} />}
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
    <LaneGroup name="filed-on">
      <LaneRow label="Filed on">
        {n === 0 ? (
          <Value>
            <span className="text-ui text-graphite">Not filed</span>
          </Value>
        ) : null}
        {note.filedAgainst.map((r) => (
          <RecordValue
            key={r.id}
            row={r}
            onPreview={onPreview}
            end={unfile(r.name, () =>
              unfileNoteFrom({ data: { id: note.id, targetId: r.id } }),
            )}
          />
        ))}
        {note.spaces.map((s) => (
          <RecordValue
            key={s.id}
            row={{ ...s, kind: 'space' }}
            dim={s.archived}
            onPreview={onPreview}
            end={
              <>
                {s.archived ? (
                  <span className="mono text-micro text-graphite">
                    archived
                  </span>
                ) : null}
                {unfile(s.name, () =>
                  untagFromSpace({
                    data: { entityId: note.id, spaceId: s.id },
                  }),
                )}
              </>
            }
          />
        ))}
        <FileOnPicker note={note} allSpaces={allSpaces} run={run} />
      </LaneRow>
    </LaneGroup>
  )
}

/** A derived list — mentions out, mentions in: icon and name, no controls. */
function LinkList({
  name,
  label,
  rows,
  onPreview,
}: {
  name: string
  label: string
  rows: ReadonlyArray<RailRecord>
  onPreview: (id: string) => void
}) {
  if (rows.length === 0) return null
  return (
    <LaneGroup name={name}>
      <LaneRow label={label}>
        {rows.map((r) => (
          <RecordValue key={r.id} row={r} onPreview={onPreview} />
        ))}
      </LaneRow>
    </LaneGroup>
  )
}

/**
 * Who may read the note: `Workspace` or `Only you`. The author holds the
 * switch beside the word; any other reader sees the word alone.
 */
function Visibility({ note }: { note: NoteData }) {
  const router = useRouter()
  const [isPrivate, setIsPrivate] = useState(note.isPrivate)
  const [pending, setPending] = useState(false)
  const words = isPrivate ? 'Only you' : 'Workspace'

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
    <LaneGroup name="visibility">
      <LaneRow label="Visible to">
        <Value>
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
        </Value>
      </LaneRow>
    </LaneGroup>
  )
}

function History({ note }: { note: NoteData }) {
  const { today } = useClock()
  return (
    <LaneGroup name="history">
      {noteHistory(note).map((h) => (
        <LaneRow key={h.event} label={h.event}>
          <Value>
            <span className="truncate mono text-micro text-graphite">
              {[formatDay(h.at, today), h.who]
                .filter((part) => part !== null)
                .join(' · ')}
            </span>
          </Value>
        </LaneRow>
      ))}
    </LaneGroup>
  )
}

/**
 * The note's rail, right of the body card on the bone ground and unboxed,
 * read as a property grid: where it is filed, what it mentions, what
 * mentions it, who may read it, when it was written and edited.
 * - `px-3` in the ground's 12px gutter lands its labels on the 24px edge.
 * - Pinned under the folded head bar and the gutter, scrolling on its own
 *   only when it is taller than the window. Below `md` it stacks under the
 *   card.
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
      className="flex w-full shrink-0 flex-col px-3 md:sticky md:top-15 md:max-h-[calc(100dvh-4.5rem)] md:w-72 md:self-start md:overflow-y-auto"
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
        rows={note.backlinks.map((b) => ({ ...b, id: b.fromId }))}
        onPreview={onPreview}
      />
      <Visibility note={note} />
      <History note={note} />
    </aside>
  )
}
