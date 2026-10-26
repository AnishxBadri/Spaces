import { Check, Filter, Plus, Save, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { ValueEditor } from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
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
import { MENU_RULE, MoreMenu } from '#/components/ui/more-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Segmented } from '#/components/ui/segmented'
import { Select } from '#/components/ui/select'
import { Tabs } from '#/components/ui/tabs'
import type { TabItem } from '#/components/ui/tabs'
import {
  PINNED_VIEWS_QUERY,
  togglePinnedView,
  usePinnedViews,
} from '#/lib/chassis-prefs'
import { countViews, deleteView, saveView } from '#/lib/server-fns'
import {
  OP_LABELS,
  isUnary,
  opsFor,
  sameJson,
  toConditionValue,
} from '@spaces/core/views/filter'
import type {
  Condition,
  ConditionOp,
  ConditionValue,
  ViewExtra,
} from '@spaces/core/views/filter'
import { viewTarget } from '@spaces/core/views/target'
import type { ViewRow, ViewSort } from '@spaces/core/writes/views/store'
import type { ViewCount } from '#/lib/views/counts'

/**
 * Views on an object list: the saved views as real tabs on the bone bar —
 * `All` with the list's total, each view with its count, `+ view` — and on
 * the same bar's right the Filter popover and the table's own tools. The page
 * owns its table state and hands the bar a snapshot to compare and to save.
 * `?view=` in the URL makes a view linkable.
 * - The active view's `···` menu pins it to the sidebar (an object list's
 *   views only — the sidebar lists them under their object) and, for a view
 *   the user may edit, renames or deletes it.
 * - Object surfaces only: a shelf is not one, and has no saved views.
 */

/** The `All` tab's id; a view id is a uuid, so the two never meet. */
const ALL = 'all'

export type ViewSnapshot = {
  filter: Array<Condition>
  sort: ViewSort
  columns: Record<string, boolean>
  extra: ViewExtra
}

export function ViewBar({
  objectId,
  registry,
  views,
  counts,
  total,
  tools,
  activeId,
  snapshot,
  onApply,
  selectView,
  onFilterChange,
  onSaved,
  canEdit,
}: {
  /**
   * The object row this list's records belong to, or null on a surface that
   * has none (/files). `viewTarget` turns it into the surface key the
   * three view server fns take.
   */
  objectId: string | null
  registry: Array<RegistryEntry>
  views: Array<ViewRow>
  /**
   * Each saved view's record count, from `countViews` in the page's loader
   * — SQL through `compileConditions`, so every chip has its
   * number on first paint, the inactive ones included. Omitted on
   * /files, which is the one surface that is not counted: its registry
   * is synthetic and its conditions do not compile to SQL (see `countViews`).
   */
  counts?: Record<string, ViewCount>
  /** Every record on the list, unfiltered: the `All` tab's count. */
  total?: number | undefined
  /** The table's tools, right of Filter on the same bar. */
  tools?: ReactNode
  /** the view the page is currently showing, from `?view=` */
  activeId: string | null
  /** the page's current filter/sort/columns/extra */
  snapshot: ViewSnapshot
  /** the page applies a view (or "All" when null) */
  onApply: (v: ViewRow | null) => void
  /** the page puts the view id in its URL (`?view=`) */
  selectView: (id: string | null) => void
  onFilterChange: (next: Array<Condition>) => void
  onSaved: () => void
  canEdit: (v: ViewRow) => boolean
}) {
  const active = views.find((v) => v.id === activeId) ?? null
  const dirty =
    active !== null &&
    !sameJson(
      {
        filter: active.filter,
        sort: active.sort,
        columns: active.columns,
        extra: active.extra,
      },
      snapshot,
    )
  const [saving, setSaving] = useState<'new' | 'rename' | null>(null)
  const pins = usePinnedViews()
  const queryClient = useQueryClient()
  /** A rename or a delete shows in the sidebar's pinned rows at once. */
  const refreshPins = () =>
    void queryClient.invalidateQueries({ queryKey: [PINNED_VIEWS_QUERY] })

  /**
   * The active chip moves with the table: while its conditions differ from
   * the saved ones, the page's current filter is counted through the same
   * server fn, keyed on the conditions the way the table's own query is.
   * Sort and column edits make the view dirty but cannot change its count,
   * so they ask nothing. `keepPreviousData` holds the last number while the
   * next is in flight rather than blanking the slot.
   */
  const live =
    active !== null &&
    objectId !== null &&
    counts !== undefined &&
    !sameJson(active.filter, snapshot.filter)
      ? { objectId, viewId: active.id, filter: snapshot.filter }
      : null
  const liveCount = useQuery({
    queryKey: ['view-count-live', live],
    queryFn: (): Promise<Record<string, ViewCount>> =>
      live
        ? countViews({
            data: {
              surface: 'object',
              objectId: live.objectId,
              viewIds: [live.viewId],
              live: { viewId: live.viewId, filter: live.filter },
            },
          })
        : Promise.resolve({}),
    enabled: live !== null,
    placeholderData: keepPreviousData,
  })
  const countOf = (id: string): ViewCount | undefined =>
    (live?.viewId === id ? liveCount.data?.[id] : undefined) ?? counts?.[id]

  async function persist(target: {
    id?: string
    name: string
    visibility: 'shared' | 'private'
  }) {
    const saved = await saveView({
      data: { ...target, ...viewTarget(objectId), ...snapshot },
    })
    if (target.id !== undefined && pins.includes(target.id)) refreshPins()
    onSaved()
    selectView(saved.id)
    return saved
  }

  async function deleteActive(view: ViewRow) {
    try {
      await deleteView({ data: { id: view.id, ...viewTarget(objectId) } })
      toast(`${view.name} deleted`)
      if (pins.includes(view.id)) refreshPins()
      onApply(null)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete')
    }
  }

  const items: Array<TabItem<string>> = [
    { id: ALL, label: 'All', count: total },
    ...views.map((v) => {
      const count = countOf(v.id)
      return {
        id: v.id,
        label: (
          <ViewLabel
            name={v.name}
            dirty={v.id === activeId && dirty}
            shared={v.visibility === 'shared'}
            count={count}
          />
        ),
        count:
          count === undefined || count.count === null ? undefined : count.count,
      }
    }),
  ]

  return (
    <Tabs
      label="Views"
      items={items}
      value={active?.id ?? ALL}
      onValueChange={(id) =>
        onApply(id === ALL ? null : (views.find((v) => v.id === id) ?? null))
      }
      trail={
        <>
          {active && dirty && canEdit(active) ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                persist({
                  id: active.id,
                  name: active.name,
                  visibility: active.visibility,
                })
                  .then(() => toast(`${active.name} updated`))
                  .catch((err: unknown) =>
                    toast.error(
                      err instanceof Error ? err.message : 'Could not save',
                    ),
                  )
              }}
            >
              <Save className="size-3" strokeWidth={2} />
              Update view
            </Button>
          ) : null}
          {active ? (
            <MoreMenu
              variant="row"
              modal={false}
              align="start"
              label={`the ${active.name} view`}
              items={[
                ...(objectId !== null
                  ? [
                      {
                        label: pins.includes(active.id)
                          ? 'Unpin'
                          : 'Pin to sidebar',
                        onSelect: () => {
                          const pinned = pins.includes(active.id)
                          togglePinnedView(active.id)
                          toast(
                            pinned
                              ? `${active.name} unpinned`
                              : `${active.name} pinned to the sidebar`,
                          )
                        },
                      },
                    ]
                  : []),
                MENU_RULE,
                ...(canEdit(active)
                  ? [
                      {
                        label: 'Rename…',
                        opens: true,
                        onSelect: () => setSaving('rename'),
                      },
                      {
                        label: 'Delete view',
                        destructive: true,
                        onSelect: () => void deleteActive(active),
                      },
                    ]
                  : []),
              ]}
            />
          ) : null}
          <button
            type="button"
            onClick={() => setSaving('new')}
            title="Save the current filter, sort and columns as a view"
            className="focus-ring flex h-7 shrink-0 items-center rounded-md px-2 mono text-micro text-primary transition-colors duration-150 ease-out-quart hover:bg-paper"
          >
            + view
          </button>
          <span className="flex-1" />

          <FilterPopover
            registry={registry}
            conditions={snapshot.filter}
            onChange={onFilterChange}
          />
          {tools}

          <SaveViewDialog
            open={saving !== null}
            onOpenChange={(o) => {
              if (!o) setSaving(null)
            }}
            initial={
              saving === 'rename' && active
                ? { name: active.name, visibility: active.visibility }
                : { name: '', visibility: 'private' }
            }
            title={saving === 'rename' ? 'Rename view' : 'Save view'}
            onSubmit={async (v) => {
              await persist(
                saving === 'rename' && active ? { id: active.id, ...v } : v,
              )
              toast(`${v.name} saved`)
              setSaving(null)
            }}
          />
        </>
      }
    />
  )
}

/**
 * A view tab's label: the name, a dash where the view cannot be counted,
 * and the pine dot while its conditions differ from the saved ones. The
 * reasons are the tab's hover.
 */
function ViewLabel({
  name,
  dirty,
  shared,
  count,
}: {
  name: string
  dirty: boolean
  shared: boolean
  /** undefined: this surface is not counted, so the tab prints no slot */
  count: ViewCount | undefined
}) {
  // A view the compiler cannot express prints no number — never one from a
  // partial `where` — and says why on hover.
  const notes = [
    shared ? 'Shared view' : null,
    count?.count === null ? count.reason : null,
  ].filter((t) => t !== null)
  return (
    <span
      className="flex items-center gap-2"
      {...(notes.length > 0 ? { title: notes.join(' · ') } : {})}
    >
      {name}
      {count?.count === null ? (
        <span aria-label={count.reason} className="text-graphite">
          –
        </span>
      ) : null}
      {dirty ? (
        <span aria-label="unsaved changes" className="size-1.5 bg-primary" />
      ) : null}
    </span>
  )
}

/**
 * Conditions editor: attribute → op → value. The value control is the
 * record's own editor for that type, so a select condition picks from the
 * same options a record does.
 */
function FilterPopover({
  registry,
  conditions,
  onChange,
}: {
  registry: Array<RegistryEntry>
  conditions: Array<Condition>
  onChange: (next: Array<Condition>) => void
}) {
  const bySlug = useMemo(
    () => new Map(registry.map((d) => [d.slug, d])),
    [registry],
  )
  const update = (i: number, patch: Partial<Condition>) =>
    onChange(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const first = registry.at(0)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant={conditions.length > 0 ? 'outline' : 'ghost'}>
          <Filter className="size-3" strokeWidth={2} />
          Filter
          {conditions.length > 0 ? (
            <span className="tabular text-graphite">{conditions.length}</span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[28rem] p-3">
        <div className="space-y-2">
          {conditions.length === 0 ? (
            <p className="text-ui text-graphite">
              No conditions. Every record shows.
            </p>
          ) : null}
          {conditions.map((c, i) => {
            const def = bySlug.get(c.slug)
            const ops = def ? opsFor(def.type) : []
            return (
              <div key={i} className="flex items-center gap-1.5">
                {/*
                  The one picker that sits inside a scroll container: the
                  conditions list scrolls when a view has more of them than
                  the popover is tall, so the trigger takes the inset reticle
                  (an offset one would be clipped by the scroller). Its sheet
                  sizes to the attribute names, not to the fixed 160px trigger
                  (fixed, because a trigger that resizes with its value is a
                  shift).
                */}
                <Select
                  aria-label="Attribute"
                  value={c.slug}
                  onChange={(slug) => {
                    const d = bySlug.get(slug)
                    update(i, {
                      slug,
                      op: d ? opsFor(d.type)[0] : 'is',
                      value: undefined,
                    })
                  }}
                  items={registry.map((d) => ({
                    value: d.slug,
                    label: d.name,
                  }))}
                  width="content"
                  inset
                  searchPlaceholder="Search attributes…"
                  emptyLabel="No attribute matches."
                  className="w-40 shrink-0 bg-transparent"
                />
                {/* The items are typed `ConditionOp` by `opsFor`, so the picker
                    hands back the op the stored condition holds. */}
                <Select
                  aria-label="Operator"
                  value={c.op}
                  onChange={(op) => update(i, { op })}
                  items={ops.map((op) => ({
                    value: op,
                    label: OP_LABELS[op],
                  }))}
                  width="content"
                  className="w-36 shrink-0 bg-transparent"
                />
                {def && !isUnary(c.op) ? (
                  <div className="min-w-0 flex-1">
                    <ConditionValueEditor
                      def={def}
                      op={c.op}
                      value={c.value}
                      onChange={(value) => update(i, { value })}
                    />
                  </div>
                ) : (
                  <span className="flex-1" />
                )}
                <button
                  type="button"
                  aria-label="Remove condition"
                  onClick={() => onChange(conditions.filter((_, j) => j !== i))}
                  className="focus-ring flex size-7 shrink-0 items-center justify-center rounded-md text-graphite hover:bg-bone hover:text-foreground"
                >
                  <X className="size-3.5" strokeWidth={2} />
                </button>
              </div>
            )
          })}
          <div className="flex items-center justify-between pt-1">
            <Button
              size="xs"
              variant="outline"
              disabled={!first}
              onClick={() =>
                first &&
                onChange([
                  ...conditions,
                  { slug: first.slug, op: opsFor(first.type)[0] },
                ])
              }
            >
              <Plus className="size-3" strokeWidth={2} />
              Add condition
            </Button>
            {conditions.length > 0 ? (
              <Button size="xs" variant="ghost" onClick={() => onChange([])}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ConditionValueEditor({
  def,
  op,
  value,
  onChange,
}: {
  def: RegistryEntry
  op: ConditionOp
  value: ConditionValue | undefined
  onChange: (v: ConditionValue | undefined) => void
}) {
  // gt/lt on a date or number, and contains on text, want a plain input —
  // the record editor's option/star pickers make no sense for a threshold.
  if (op === 'contains' || op === 'gt' || op === 'lt')
    return (
      <Input
        type={
          def.type === 'date'
            ? 'date'
            : def.type === 'text' || op === 'contains'
              ? 'text'
              : 'number'
        }
        value={value == null ? '' : String(value)}
        placeholder="Value"
        aria-label="Value"
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') return onChange(undefined)
          onChange(def.type === 'date' || op === 'contains' ? raw : Number(raw))
        }}
        className="h-8 text-ui"
      />
    )
  // A condition compares one value: a multi-select takes the single picker,
  // a multi phone the single number box.
  const single: RegistryEntry =
    def.type === 'multi_select'
      ? { ...def, type: 'select' }
      : def.type === 'phone' && def.options?.multi
        ? { ...def, options: { ...def.options, multi: false } }
        : def
  return (
    <ValueEditor
      def={single}
      value={value ?? null}
      variant="field"
      onSave={(v) => onChange(toConditionValue(v))}
    />
  )
}

function SaveViewDialog({
  open,
  onOpenChange,
  initial,
  title,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: { name: string; visibility: 'shared' | 'private' }
  title: string
  onSubmit: (v: {
    name: string
    visibility: 'shared' | 'private'
  }) => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="s" aria-describedby={undefined}>
        {open ? (
          <SaveViewForm
            key={`${initial.name}:${initial.visibility}`}
            initial={initial}
            title={title}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SaveViewForm({
  initial,
  title,
  onSubmit,
}: {
  initial: { name: string; visibility: 'shared' | 'private' }
  title: string
  onSubmit: (v: {
    name: string
    visibility: 'shared' | 'private'
  }) => Promise<void>
}) {
  const [name, setName] = useState(initial.name)
  const [visibility, setVisibility] = useState(initial.visibility)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit() {
    if (!name.trim()) return setError('Name the view.')
    setPending(true)
    try {
      await onSubmit({ name: name.trim(), visibility })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          void submit()
        }
      }}
      className="space-y-4"
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="view-name">Name</Label>
        <Input
          id="view-name"
          value={name}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="Seed-stage watchlist"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <Segmented
        label="Visibility"
        value={visibility}
        options={[
          { id: 'private', label: 'Private' },
          { id: 'shared', label: 'Shared' },
        ]}
        onChange={setVisibility}
      />
      {error ? (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          <Check className="size-4" strokeWidth={2} />
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}
