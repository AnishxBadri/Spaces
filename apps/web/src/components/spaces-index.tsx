import { Link, useRouter } from '@tanstack/react-router'
import { Layers } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { LedgerRow, rowWashClass } from '#/components/ledger-section'
import { PageHeader } from '#/components/page-header'
import { TemplatePicker } from '#/components/templates'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Select } from '#/components/ui/select'
import { useBornRows } from '#/lib/born-rows'
import { formatAge, formatDay } from '@spaces/core/format'
import { DASH } from '#/lib/records/readout-format'
import { applySpaceTemplate, createSpace, restoreSpace } from '#/lib/server-fns'
import { spacePaths, treeRows } from '#/lib/spaces/index-tree'
import type { TreeMark } from '#/lib/spaces/index-tree'
import type { getSpacesIndex } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

export type SpacesIndex = Awaited<ReturnType<typeof getSpacesIndex>>
type SpaceRow = SpacesIndex['spaces'][number]
type ArchivedRow = SpacesIndex['archived'][number]

/** The market map's fixed lanes, right of the name: 88 · 72 · 72 · 96. */
const LANES = {
  companies: 'w-22',
  memos: 'w-18',
  terms: 'w-18',
  lastFiled: 'w-24',
} as const

/** A figure in its lane: a rule-grey dash when there is nothing. */
function Lane({
  width,
  children,
  tone = 'ink',
}: {
  width: string
  children: string | number | null
  tone?: 'ink' | 'graphite'
}) {
  const empty = children === null || children === 0
  return (
    <span
      className={cn(
        width,
        'flex shrink-0 justify-end mono text-label whitespace-nowrap max-md:hidden',
        empty
          ? 'text-rule'
          : tone === 'ink'
            ? 'text-foreground'
            : 'text-graphite',
      )}
    >
      {empty ? DASH : children}
    </span>
  )
}

/**
 * The spaces index: the market map as one tree, its last filed lane,
 * the composer row, the archived fold and the New space window.
 */
export function SpacesIndexPage({
  index: { spaces, archived, today },
}: {
  index: SpacesIndex
}) {
  const [open, setOpen] = useState(false)
  // The composer row's arrivals, and only those: a space the loader already
  // knew about is never in the set, however recently it was created.
  const { washes, bear } = useBornRows()
  useHotkey('s', () => setOpen(true))

  const nested = spaces.filter((s) => s.depth > 0).length

  return (
    <div className="flex min-h-full flex-col">
      {/* No head button: the composer row at the list's end is the one
          way to a new space, and `S` opens it. */}
      <PageHeader
        title="Spaces"
        description={
          spaces.length > 0 ? (
            <span data-spaces-meta>
              {spaces.length} space{spaces.length === 1 ? '' : 's'} · {nested}{' '}
              nested
            </span>
          ) : undefined
        }
      />

      <div className="px-8 pt-4 pb-8">
        {spaces.length === 0 ? (
          <MarketsCreator />
        ) : (
          <section className="flex flex-col">
            <div
              data-lane-heads
              className="flex h-7 items-center gap-2.5 border-b border-hairline px-3 text-label text-graphite"
            >
              <span className="min-w-0 flex-1">Space</span>
              <span className={cn(LANES.companies, 'text-right max-md:hidden')}>
                Companies
              </span>
              <span className={cn(LANES.memos, 'text-right max-md:hidden')}>
                Memos
              </span>
              <span className={cn(LANES.terms, 'text-right max-md:hidden')}>
                Terms
              </span>
              <span className={cn(LANES.lastFiled, 'text-right max-md:hidden')}>
                Last filed
              </span>
            </div>
            <ol>
              {treeRows(spaces).map((s) => (
                <MapRow
                  key={s.id}
                  space={s}
                  mark={s.mark}
                  ruled={s.groupEnd}
                  today={today}
                  wash={washes(s.id)}
                />
              ))}
              {/* The composer row: adding never starts from a corner button. */}
              <LedgerRow last>
                <button
                  type="button"
                  data-composer-row
                  onClick={() => setOpen(true)}
                  className="focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-2.5 px-3 text-left transition-colors hover:bg-bone"
                >
                  <span
                    aria-hidden
                    className="w-3.5 shrink-0 text-center mono text-ui text-primary"
                  >
                    +
                  </span>
                  <span className="min-w-0 flex-1 truncate text-body text-graphite">
                    New space…
                  </span>
                  <kbd className="shrink-0 mono text-micro text-graphite">
                    S
                  </kbd>
                </button>
              </LedgerRow>
            </ol>
          </section>
        )}
        {archived.length > 0 ? (
          <ArchivedFold
            archived={archived}
            today={today}
            className={spaces.length === 0 ? 'mt-8' : undefined}
          />
        ) : null}
      </div>

      <CreateSpaceDialog
        spaces={spaces}
        open={open}
        onOpenChange={setOpen}
        onCreated={bear}
      />
    </div>
  )
}

/**
 * One space on the map: 36px, children hung off `├` / `└` in rule grey, a
 * rule only under the last row of a top-level group.
 */
function MapRow({
  space: s,
  mark,
  ruled,
  today,
  wash,
}: {
  space: SpaceRow
  mark: TreeMark
  ruled: boolean
  today: string
  wash: boolean
}) {
  return (
    <li
      className={cn(
        'flex h-row items-center px-3',
        ruled && 'border-b border-rule',
        rowWashClass(wash),
      )}
    >
      <Link
        to="/spaces/$spaceId"
        params={{ spaceId: s.id }}
        className={cn(
          'focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-2.5 pr-3 transition-colors hover:bg-bone',
          // A top-level row sits 4px lower: its group's first line breathes.
          mark === null && 'pt-1',
        )}
        style={{ paddingLeft: `${12 + s.depth * 24}px` }}
      >
        {mark === null ? (
          <Layers
            className="size-3.5 shrink-0 text-foreground"
            strokeWidth={1.75}
          />
        ) : (
          <span
            aria-hidden
            className="w-3.5 shrink-0 text-center mono text-label text-rule"
          >
            {mark}
          </span>
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-body',
            mark === null && 'font-semibold',
          )}
        >
          {s.name}
        </span>
        <Lane width={LANES.companies}>{s.companies}</Lane>
        <Lane width={LANES.memos}>{s.memos}</Lane>
        <Lane width={LANES.terms}>{s.terms}</Lane>
        <Lane width={LANES.lastFiled} tone="graphite">
          {s.lastFiled === null ? null : formatAge(s.lastFiled, today)}
        </Lane>
      </Link>
    </li>
  )
}

/**
 * `n archived · Show` — archived spaces are out of the tree but findable
 * here, each with Restore. A row is an archive head: Restore brings back
 * every space archived with it.
 */
function ArchivedFold({
  archived,
  today,
  className,
}: {
  archived: Array<ArchivedRow>
  today: string
  className?: string | undefined
}) {
  const router = useRouter()
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  async function restore(row: ArchivedRow) {
    setBusy(row.id)
    try {
      await restoreSpace({ data: { id: row.id } })
      toast(`${row.name} restored`)
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not restore')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={cn('flex flex-col border-t border-rule', className)}>
      <div className="flex h-8 items-center gap-2.5 px-3">
        <span aria-hidden className="w-3.5 shrink-0" />
        <span className="text-label text-graphite">
          {archived.length} archived
        </span>
        <button
          type="button"
          aria-expanded={shown}
          onClick={() => setShown((v) => !v)}
          className="focus-ring rounded-md text-label text-foreground underline-offset-2 hover:underline"
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {shown ? (
        <ol>
          {archived.map((a) => (
            <li key={a.id} className="flex h-row items-center gap-2.5 px-3">
              <span aria-hidden className="w-3.5 shrink-0" />
              <Link
                to="/spaces/$spaceId"
                params={{ spaceId: a.id }}
                className="focus-ring min-w-0 truncate rounded-md text-body text-graphite hover:text-foreground"
              >
                {a.name}
              </Link>
              <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
                {[
                  a.within === null ? null : `In ${a.within}`,
                  a.spaces > 1 ? `${a.spaces} spaces` : null,
                  `Archived ${formatDay(a.archivedOn, today)}`,
                ]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </span>
              <Button
                size="xs"
                variant="outline"
                pending={busy === a.id}
                disabled={busy !== null}
                onClick={() => void restore(a)}
              >
                Restore
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/**
 * The active empty state: instead of describing
 * spaces, it asks the one question every investor can answer on day zero —
 * "what markets do you look at?" — and turns the answers into the first
 * top-level spaces. The mental model is taught by using it, on the surface
 * where space creation actually lives, not in the setup wizard.
 */
function MarketsCreator() {
  const router = useRouter()
  const [names, setNames] = useState(['', '', ''])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // Dedupe case-insensitively — two "Fintech" inputs are one market, and
    // the second would trip the slug-per-parent unique index.
    const seen = new Set<string>()
    const filled = names
      .map((n) => n.trim())
      .filter(Boolean)
      .filter((n) => {
        const key = n.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    if (filled.length === 0) {
      setError('Name at least one market.')
      return
    }
    setPending(true)
    setError(null)
    const failed: Array<string> = []
    for (const name of filled) {
      try {
        await createSpace({ data: { name } })
      } catch {
        failed.push(name)
      }
    }
    if (failed.length > 0) {
      setError(`Could not create: ${failed.join(', ')}. The rest are in.`)
      setPending(false)
    }
    if (failed.length < filled.length) void router.invalidate()
  }

  return (
    <div className="flex max-w-100 flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="font-serif text-xl leading-6 font-semibold">
          What markets do you look at?
        </h2>
        <p className="text-ui leading-5 text-graphite">
          Each one becomes a space — a node in your market map. Memos file into
          them, companies get tagged into them, and your glossary grows inside
          them. Rename, nest, or delete freely later.
        </p>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
        {names.map((n, i) => (
          <Input
            key={i}
            value={n}
            autoFocus={i === 0}
            onChange={(e) =>
              setNames((s) => s.map((v, j) => (j === i ? e.target.value : v)))
            }
            placeholder={
              ['Climate — industrial heat', 'Vertical SaaS', 'Space infra'][i]
            }
            aria-label={`Market ${i + 1}`}
          />
        ))}
        {error ? (
          <p
            role="alert"
            className="flex items-center gap-2 text-ui text-destructive"
          >
            <span aria-hidden className="size-2 shrink-0 bg-destructive" />
            {error}
          </p>
        ) : null}
        <Button type="submit" pending={pending} className="w-full">
          {pending ? 'Creating…' : 'Create my map'}
        </Button>
        <p className="mono text-micro text-graphite">
          Three to start · blanks are skipped · duplicates fold into one
        </p>
      </form>
    </div>
  )
}

/**
 * The New space window: name, inside (the parent's path, or top level) and
 * an optional saved breakdown to stamp. Cancel in the foot is its one close.
 */
function CreateSpaceDialog({
  spaces,
  open,
  onOpenChange,
  onCreated,
}: {
  spaces: Array<SpaceRow>
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The row that landed — what the market map's wash reads. A stamped
   *  scaffold reports its root: the children are a subtree the composer
   *  did not name, and only the named row is the arrival. */
  onCreated?: (id: string) => void
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [scaffold, setScaffold] = useState<{ id: string; name: string } | null>(
    null,
  )
  // The form is still read through `FormData`; the picker mirrors its value
  // into a hidden `parent` input, so the submit path is untouched.
  const [parent, setParent] = useState('')
  const paths = spacePaths(spaces)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)
    const name = String(form.get('name')).trim()
    const parentId = String(form.get('parent') || '')
    if (!name) {
      setError('Name the space.')
      return
    }
    setPending(true)
    try {
      if (scaffold) {
        // Stamp the pattern: subtree + glossary, skip-existing. The tree it
        // creates is fully editable afterwards — copy, not reference.
        const stamped = await applySpaceTemplate({
          data: {
            templateId: scaffold.id,
            name,
            ...(parentId ? { parentId } : {}),
          },
        })
        onCreated?.(stamped.id)
      } else {
        const created = await createSpace({
          data: { name, ...(parentId ? { parentId } : {}) },
        })
        onCreated?.(created.id)
      }
      onOpenChange(false)
      setScaffold(null)
      setParent('')
      void router.invalidate()
    } catch {
      setError('Could not create the space.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3.5" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="space-name">Name</Label>
            <Input
              id="space-name"
              name="name"
              required
              autoFocus
              placeholder="Aerospace"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="space-parent">Inside</Label>
            <Select
              id="space-parent"
              name="parent"
              value={parent}
              onChange={setParent}
              items={[
                { value: '', label: 'Top level' },
                ...spaces.map((s) => ({
                  value: s.id,
                  label: paths.get(s.id) ?? s.name,
                })),
              ]}
              width="trigger"
              placeholder="Top level"
              searchPlaceholder="Search spaces…"
              emptyLabel="No space matches."
            />
          </div>
          {scaffold ? (
            <div className="flex h-6 items-center gap-2 text-ui">
              <span className="text-graphite">Stamping</span>
              <span className="min-w-0 truncate font-medium text-foreground">
                {scaffold.name}
              </span>
              <button
                type="button"
                onClick={() => setScaffold(null)}
                className="focus-ring rounded-md text-graphite hover:text-foreground"
                aria-label="Clear the breakdown"
              >
                ×
              </button>
            </div>
          ) : (
            <TemplatePicker
              kind="space"
              context="space"
              align="start"
              onPick={(t) => setScaffold({ id: t.id, name: t.name })}
              trigger={
                <button
                  type="button"
                  className="focus-ring flex h-6 items-center gap-2 self-start rounded-md text-ui text-graphite transition-colors hover:text-foreground"
                >
                  <span aria-hidden className="mono text-label text-primary">
                    +
                  </span>
                  Stamp a saved breakdown
                </button>
              }
            />
          )}

          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" pending={pending}>
              {pending ? 'Creating…' : 'Create space'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
