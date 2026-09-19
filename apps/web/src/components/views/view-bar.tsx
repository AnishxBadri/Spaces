import { Check, Filter, Plus, Save, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ValueEditor } from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { deleteView, saveView } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import {
  OP_LABELS,
  isUnary,
  opsFor,
  sameJson,
  toConditionOp,
  toConditionValue,
} from '#/lib/views/filter'
import type {
  Condition,
  ConditionOp,
  ConditionValue,
  ViewExtra,
} from '#/lib/views/filter'
import type { ViewRow, ViewSort } from '#/lib/views/store'

/**
 * Views on a list page (SPA-14): chips for the saved views, a Filter
 * popover for attribute conditions, and save/update/delete for the active
 * view. The bar owns nothing but the chips — the page owns its table state
 * and hands the bar a snapshot to compare and to save. `?view=` in the URL
 * makes a view linkable.
 */

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
  activeId,
  snapshot,
  onApply,
  selectView,
  onFilterChange,
  onSaved,
  canEdit,
}: {
  objectId: string
  registry: Array<RegistryEntry>
  views: Array<ViewRow>
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

  async function persist(target: {
    id?: string
    name: string
    visibility: 'shared' | 'private'
  }) {
    const saved = await saveView({
      data: { ...target, objectId, ...snapshot },
    })
    onSaved()
    selectView(saved.id)
    return saved
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ViewChip
        active={active === null}
        onClick={() => onApply(null)}
        label="All"
      />
      {views.map((v) => (
        <ViewChip
          key={v.id}
          active={v.id === activeId}
          dirty={v.id === activeId && dirty}
          shared={v.visibility === 'shared'}
          onClick={() => onApply(v)}
          label={v.name}
        />
      ))}

      <FilterPopover
        registry={registry}
        conditions={snapshot.filter}
        onChange={onFilterChange}
      />

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
      <Button size="xs" variant="ghost" onClick={() => setSaving('new')}>
        <Plus className="size-3" strokeWidth={2} />
        Save view
      </Button>
      {active && canEdit(active) ? (
        <>
          <Button size="xs" variant="ghost" onClick={() => setSaving('rename')}>
            Rename
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Delete view ${active.name}`}
            onClick={async () => {
              try {
                await deleteView({ data: { id: active.id } })
                toast(`${active.name} deleted`)
                onApply(null)
                onSaved()
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : 'Could not delete',
                )
              }
            }}
          >
            <Trash2 className="size-3" strokeWidth={1.75} />
          </Button>
        </>
      ) : null}

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
    </div>
  )
}

function ViewChip({
  active,
  dirty,
  shared,
  label,
  onClick,
}: {
  active: boolean
  dirty?: boolean
  shared?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'focus-ring-inset flex h-9 items-center gap-1.5 border-b-2 px-3 label-caps transition-colors duration-150 ease-out-quart',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-graphite hover:text-foreground',
      )}
      title={shared ? 'Shared view' : undefined}
    >
      {label}
      {dirty ? (
        <span aria-label="unsaved changes" className="size-1.5 bg-primary" />
      ) : null}
    </button>
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
                <select
                  aria-label="Attribute"
                  value={c.slug}
                  onChange={(e) => {
                    const d = bySlug.get(e.target.value)
                    update(i, {
                      slug: e.target.value,
                      op: d ? opsFor(d.type)[0] : 'is',
                      value: undefined,
                    })
                  }}
                  className="focus-ring h-8 max-w-40 rounded-md border border-rule bg-transparent px-2 text-ui"
                >
                  {registry.map((d) => (
                    <option key={d.slug} value={d.slug}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Operator"
                  value={c.op}
                  onChange={(e) => {
                    const op = toConditionOp(e.target.value)
                    if (op) update(i, { op })
                  }}
                  className="focus-ring h-8 rounded-md border border-rule bg-transparent px-2 text-ui"
                >
                  {ops.map((op) => (
                    <option key={op} value={op}>
                      {OP_LABELS[op]}
                    </option>
                  ))}
                </select>
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
  // Multi-select: a condition compares one option, so use the single picker.
  const single: RegistryEntry =
    def.type === 'multi_select' ? { ...def, type: 'select' } : def
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
      <DialogContent className="sm:max-w-sm">
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
        <DialogDescription>
          The current filter, columns, and sort, under a name. Shared views show
          for everyone; private ones only for you.
        </DialogDescription>
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
      <div
        role="radiogroup"
        aria-label="Visibility"
        className="flex h-8 w-fit items-center border border-hairline"
      >
        {(['private', 'shared'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={visibility === v}
            onClick={() => setVisibility(v)}
            className={cn(
              'focus-ring-inset h-full px-2.5 text-ui font-medium capitalize transition-colors duration-150 ease-out-quart',
              visibility === v
                ? 'bg-hairline text-paper'
                : 'text-graphite hover:bg-bone hover:text-foreground',
            )}
          >
            {v}
          </button>
        ))}
      </div>
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
