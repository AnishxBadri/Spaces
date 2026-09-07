import { useRouter } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Pencil,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from './attribute-dialog'
import { IconBtn } from './option-list-editor'
import { badgeStyle, optionColor } from '#/lib/attributes/colors'
import { reorderAttributes, updateAttribute } from '#/lib/server-fns'
import type { listRegistry } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * One object's registry as a settings list (spec §7): name, type and
 * constraint summary, system badge, drag to reorder (persists sort_order,
 * which every table and rail reads), archive/restore, edit through the
 * morphing dialog. Archived attributes wait in a collapsed section — never
 * deleted, values intact, one click from coming back. Keyed on the object
 * row, so a custom object gets exactly this page.
 */

export type RegistryAttr = Awaited<ReturnType<typeof listRegistry>>[number]

export type ObjectRow = {
  id: string
  slug: string
  singular: string
  plural: string
  isSystem: boolean
}

export const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  currency: 'Currency',
  date: 'Date',
  checkbox: 'Checkbox',
  select: 'Select',
  multi_select: 'Multi-select',
  status: 'Status',
  domain: 'Domain',
  email: 'Email',
  url: 'URL',
  phone: 'Phone',
  rating: 'Rating',
  record_reference: 'Relationship',
  actor_reference: 'User',
}

function moveItem<T>(list: Array<T>, from: number, to: number): Array<T> {
  if (to < 0 || to >= list.length || from === to) return list
  const next = [...list]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row)
  return next
}

export function RegistryList({
  object,
  registry,
  canReshape,
}: {
  object: ObjectRow
  registry: Array<RegistryAttr>
  canReshape: boolean
}) {
  const router = useRouter()
  const live = registry.filter((a) => !a.archived)
  const archived = registry.filter((a) => a.archived)
  // Optimistic order: the drop reorders locally at once, the server write
  // follows; a failure snaps back to what the loader last returned.
  const [order, setOrder] = useState(live.map((a) => a.id))
  useEffect(() => {
    setOrder(live.map((a) => a.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ids the loader delivers
  }, [live.map((a) => a.id).join(',')])
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const byId = new Map(registry.map((a) => [a.id, a]))
  const ordered = order.flatMap((id) => {
    const a = byId.get(id)
    return a ? [a] : []
  })

  async function persist(next: Array<string>) {
    const prev = order
    setOrder(next)
    try {
      await reorderAttributes({ data: { objectId: object.id, ids: next } })
      void router.invalidate()
    } catch (err) {
      setOrder(prev)
      toast.error(err instanceof Error ? err.message : 'Could not reorder')
    }
  }

  return (
    <div className="space-y-4">
      <ul
        className="divide-y divide-border/60 rounded-lg border border-border"
        aria-label={`${object.plural} attributes`}
      >
        {ordered.map((attr, idx) => (
          <AttributeRow
            key={attr.id}
            attr={attr}
            object={object}
            canReshape={canReshape}
            isFirst={idx === 0}
            isLast={idx === ordered.length - 1}
            dragging={dragging === attr.id}
            over={over === attr.id && dragging !== attr.id}
            onMove={(dir) =>
              persist(moveItem(order, idx, dir === 'up' ? idx - 1 : idx + 1))
            }
            onDragStart={() => setDragging(attr.id)}
            onDragOver={() => {
              if (over !== attr.id) setOver(attr.id)
            }}
            onDragEnd={() => {
              setDragging(null)
              setOver(null)
            }}
            onDrop={() => {
              const from = dragging ? order.indexOf(dragging) : -1
              setDragging(null)
              setOver(null)
              if (from >= 0) void persist(moveItem(order, from, idx))
            }}
          />
        ))}
        {ordered.length === 0 ? (
          <li className="px-4 py-6 text-center text-ui text-muted-foreground">
            No attributes yet — add the first one above.
          </li>
        ) : null}
      </ul>

      {archived.length > 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-1.5 rounded-md text-ui text-muted-foreground focus-ring hover:text-foreground"
          >
            {showArchived ? (
              <ChevronDown className="size-3.5" strokeWidth={2} />
            ) : (
              <ChevronRight className="size-3.5" strokeWidth={2} />
            )}
            Archived
            <span className="tabular text-xs">{archived.length}</span>
          </button>
          {showArchived ? (
            <ul className="mt-2 divide-y divide-border/60 rounded-lg border border-dashed border-border">
              {archived.map((attr) => (
                <AttributeRow
                  key={attr.id}
                  attr={attr}
                  object={object}
                  canReshape={canReshape}
                  isFirst
                  isLast
                  dragging={false}
                  over={false}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function AttributeRow({
  attr,
  object,
  canReshape,
  isFirst,
  isLast,
  dragging,
  over,
  onMove,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  attr: RegistryAttr
  object: ObjectRow
  canReshape: boolean
  isFirst: boolean
  isLast: boolean
  dragging: boolean
  over: boolean
  onMove?: (dir: 'up' | 'down') => void
  onDragStart?: () => void
  onDragOver?: () => void
  onDragEnd?: () => void
  onDrop?: () => void
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const draggable = Boolean(onDragStart) && canReshape

  async function act(
    patch: Parameters<typeof updateAttribute>[0]['data'] extends infer D
      ? Omit<D, 'id'>
      : never,
    message?: string,
  ) {
    try {
      await updateAttribute({ data: { id: attr.id, ...patch } })
      if (message) toast(message)
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update')
    }
  }

  const stored = (attr.options ?? {}) as {
    options?: Array<{
      id: string
      label: string
      group?: string
      color?: string
      archived?: boolean
    }>
    code?: string
    max?: number
    precision?: number
    targetKind?: string
    required?: boolean
    default?: unknown
  }
  const options = stored.options ?? []
  const hasOptions = ['select', 'multi_select', 'status'].includes(attr.type)
  const summary = [
    attr.type === 'record_reference' && stored.targetKind
      ? `→ ${stored.targetKind}`
      : null,
    attr.type === 'currency' ? (stored.code ?? 'USD') : null,
    attr.type === 'rating' ? `out of ${stored.max ?? 5}` : null,
    attr.type === 'number' && stored.precision !== undefined
      ? `${stored.precision} decimals`
      : null,
    stored.required ? 'required' : null,
    stored.default !== undefined && stored.default !== null
      ? 'has default'
      : null,
  ].filter(Boolean)

  return (
    <li
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/attribute-id', attr.id)
        onDragStart?.()
      }}
      onDragOver={(e) => {
        if (!onDragOver) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onDragOver()
      }}
      onDragEnd={onDragEnd}
      onDrop={(e) => {
        if (!onDrop) return
        e.preventDefault()
        onDrop()
      }}
      className={cn(
        'flex flex-col gap-2 px-3 py-3 transition-[background-color,opacity] duration-150 ease-out-quart',
        attr.archived && 'opacity-60',
        dragging && 'opacity-50',
        over && 'bg-accent',
      )}
    >
      <div className="flex items-center gap-2">
        {onDragStart ? (
          <span
            aria-hidden
            className={cn(
              'flex size-6 shrink-0 items-center justify-center text-muted-foreground',
              draggable
                ? 'cursor-grab touch-none active:cursor-grabbing'
                : 'opacity-30',
            )}
          >
            <GripVertical className="size-3.5" strokeWidth={1.75} />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <InlineName
            name={attr.name}
            disabled={!canReshape}
            onSave={(name) => act({ name })}
          />
          <span className="text-xs text-muted-foreground">
            {TYPE_LABELS[attr.type] ?? attr.type}
            {summary.length > 0 ? ` · ${summary.join(' · ')}` : ''}
          </span>
          {attr.description ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {attr.description}
            </p>
          ) : null}
        </div>

        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            attr.isSystem
              ? 'bg-muted text-muted-foreground'
              : 'bg-selected text-foreground',
          )}
        >
          {attr.isSystem ? 'System' : 'Custom'}
        </span>

        <div className="flex items-center gap-0.5">
          {onMove ? (
            <>
              <IconBtn
                label="Move up"
                disabled={isFirst || !canReshape}
                onClick={() => onMove('up')}
              >
                <ArrowUp className="size-3.5" strokeWidth={1.75} />
              </IconBtn>
              <IconBtn
                label="Move down"
                disabled={isLast || !canReshape}
                onClick={() => onMove('down')}
              >
                <ArrowDown className="size-3.5" strokeWidth={1.75} />
              </IconBtn>
            </>
          ) : null}
          <IconBtn
            label="Edit attribute"
            disabled={!canReshape}
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn
            label={attr.archived ? 'Restore' : 'Archive'}
            disabled={!canReshape}
            onClick={() =>
              act(
                { archived: !attr.archived },
                attr.archived
                  ? `${attr.name} restored`
                  : `${attr.name} archived`,
              )
            }
          >
            {attr.archived ? (
              <ArchiveRestore className="size-3.5" strokeWidth={1.75} />
            ) : (
              <Archive className="size-3.5" strokeWidth={1.75} />
            )}
          </IconBtn>
        </div>
      </div>

      {hasOptions && options.length > 0 ? (
        <div className={cn('flex flex-wrap gap-1', onDragStart && 'pl-8')}>
          {options.map((o, i) => (
            <span
              key={o.id}
              style={o.archived ? undefined : badgeStyle(optionColor(o, i))}
              title={o.archived ? 'Archived option' : undefined}
              className={cn(
                'rounded-full px-2 py-0.5 text-label font-medium',
                o.archived && 'bg-muted text-muted-foreground',
              )}
            >
              {o.label}
            </span>
          ))}
        </div>
      ) : null}

      <AttributeDialog
        mode="edit"
        attr={attr}
        objectId={object.id}
        objectLabel={object.singular}
        open={editing}
        onOpenChange={setEditing}
        onSaved={() => router.invalidate()}
      />
    </li>
  )
}

function InlineName({
  name,
  disabled,
  onSave,
}: {
  name: string
  disabled?: boolean
  onSave: (name: string) => void
}) {
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  return (
    <input
      value={draft}
      disabled={disabled}
      aria-label="Attribute name"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() && draft !== name && onSave(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(name)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className="block w-full truncate rounded bg-transparent text-ui font-medium focus-ring disabled:opacity-100"
    />
  )
}
