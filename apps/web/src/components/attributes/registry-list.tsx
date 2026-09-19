import { useRouter } from '@tanstack/react-router'
import { Archive, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from './attribute-dialog'
import { Button } from '#/components/ui/button'
import { badgeStyle, optionColor } from '@spaces/core/attributes/colors'
import { reorderAttributes, updateAttribute } from '#/lib/server-fns'
import type { listRegistry } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * One object's registry as a settings ledger (spec §7; Instrument
 * "Settings — Object" board): a caps column head on a hairline, rows on
 * rules — grip · name (+ description, + option badges) · type · constraints
 * · origin · order/edit — and a mono foot that says what the order feeds.
 * Drag or ↑↓ persists sort_order, which every table and rail reads.
 * Archived attributes wait in a collapsed section below — never deleted,
 * values intact, one click from coming back. Keyed on the object row, so a
 * custom object gets exactly this page.
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

// The lanes, shared by the head and every row so they stay one grid.
const LANE = {
  grip: 'w-6 shrink-0',
  type: 'w-35 shrink-0',
  constraints: 'w-50 shrink-0 max-lg:hidden',
  origin: 'w-18 shrink-0',
  actions: 'w-28 shrink-0',
} as const

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
    <div className="flex flex-col gap-6">
      <section className="flex flex-col">
        <div
          aria-hidden
          className="flex h-8 items-center gap-3 border-b border-hairline label-caps text-graphite"
        >
          <span className={LANE.grip} />
          <span className="min-w-0 flex-1">Attribute</span>
          <span className={LANE.type}>Type</span>
          <span className={LANE.constraints}>Constraints</span>
          <span className={LANE.origin}>Origin</span>
          <span className={cn(LANE.actions, 'text-right')}>Order · edit</span>
        </div>
        <ol aria-label={`${object.plural} attributes`}>
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
            <li className="flex h-row items-center border-b border-rule text-ui text-graphite">
              No attributes yet — add the first one above.
            </li>
          ) : null}
        </ol>
        <div className="flex h-8 items-center justify-between gap-4 mono text-micro text-graphite">
          <span>{ordered.length} live · drag ⋮⋮ or ↑↓ to reorder</span>
          <span className="max-md:hidden">
            order feeds every table and rail · types never change
          </span>
        </div>
      </section>

      {archived.length > 0 ? (
        <section className="flex flex-col">
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className="focus-ring-inset flex h-8 items-center gap-2 border-b border-hairline text-left"
          >
            <span className="w-3 mono text-micro text-graphite">
              {showArchived ? '⌄' : '›'}
            </span>
            <span className="label-caps text-foreground">Archived</span>
            <span className="mono text-micro text-graphite">
              {archived.length} · values kept, one click back
            </span>
          </button>
          {showArchived ? (
            <ol aria-label={`${object.plural} archived attributes`}>
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
            </ol>
          ) : null}
        </section>
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

  const stored = attr.options
  const options = stored.options ?? []
  const hasOptions = ['select', 'multi_select', 'status'].includes(attr.type)
  const constraints = [
    hasOptions
      ? `${options.length} option${options.length === 1 ? '' : 's'}`
      : null,
    attr.type === 'record_reference'
      ? `→ ${stored.targetKind ?? 'your object'}`
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
    attr.archived ? 'values kept' : null,
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
        'flex flex-col border-b border-rule transition-[background-color,opacity] duration-150 ease-out-quart',
        dragging && 'opacity-50',
        over && 'bg-bone',
      )}
    >
      <div className="flex min-h-10 items-center gap-3 py-2">
        <span
          aria-hidden
          className={cn(
            LANE.grip,
            'flex justify-center mono text-label',
            onDragStart && draggable
              ? 'cursor-grab touch-none text-rule active:cursor-grabbing'
              : 'text-transparent',
          )}
        >
          ⋮⋮
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <InlineName
            name={attr.name}
            disabled={!canReshape}
            muted={attr.archived}
            onSave={(name) => act({ name })}
          />
          {attr.description ? (
            <p className="truncate text-label text-graphite">
              {attr.description}
            </p>
          ) : null}
        </div>

        <span
          className={cn(
            LANE.type,
            'truncate mono text-label',
            attr.archived ? 'text-graphite' : 'text-foreground',
          )}
        >
          {attr.type}
        </span>

        <span
          className={cn(
            LANE.constraints,
            'truncate mono text-label text-graphite',
          )}
        >
          {constraints.length > 0 ? constraints.join(' · ') : '—'}
        </span>

        <span className={cn(LANE.origin, 'flex')}>
          <span
            className={cn(
              'h-4 px-1.25 field-label leading-4 font-medium',
              attr.isSystem
                ? 'bg-bone text-graphite'
                : 'bg-selected text-foreground',
            )}
          >
            {attr.isSystem ? 'system' : 'custom'}
          </span>
        </span>

        <span className={cn(LANE.actions, 'flex justify-end gap-0.5')}>
          {attr.archived ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canReshape}
              onClick={() => act({ archived: false }, `${attr.name} restored`)}
            >
              Restore
            </Button>
          ) : (
            <>
              {onMove ? (
                <>
                  <RowBtn
                    label="Move up"
                    disabled={isFirst || !canReshape}
                    onClick={() => onMove('up')}
                  >
                    ↑
                  </RowBtn>
                  <RowBtn
                    label="Move down"
                    disabled={isLast || !canReshape}
                    onClick={() => onMove('down')}
                  >
                    ↓
                  </RowBtn>
                </>
              ) : null}
              <RowBtn
                label="Edit attribute"
                disabled={!canReshape}
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3" strokeWidth={1.75} />
              </RowBtn>
              <RowBtn
                label="Archive"
                disabled={!canReshape}
                onClick={() => act({ archived: true }, `${attr.name} archived`)}
              >
                <Archive className="size-3" strokeWidth={1.75} />
              </RowBtn>
            </>
          )}
        </span>
      </div>

      {hasOptions && options.length > 0 ? (
        <div className="flex flex-wrap gap-1 pb-2.5 pl-9">
          {options.map((o, i) => (
            <span
              key={o.id}
              style={o.archived ? undefined : badgeStyle(optionColor(o, i))}
              title={o.archived ? 'Archived option' : undefined}
              className={cn(
                'flex h-5 items-center px-1.5 mono text-micro font-medium',
                o.archived && 'bg-bone font-normal text-graphite line-through',
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
        objectPlural={object.plural}
        open={editing}
        onOpenChange={setEditing}
        onSaved={() => router.invalidate()}
      />
    </li>
  )
}

/** A 24px mark in the row's action lane: mono glyph or 12px icon, graphite
 *  until hover, rule when disabled. Always visible — nothing needs hover. */
function RowBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="focus-ring flex size-6 shrink-0 touch-manipulation items-center justify-center rounded-md mono text-label text-graphite transition-colors duration-150 ease-out-quart hover:bg-bone hover:text-foreground disabled:pointer-events-none disabled:text-rule"
    >
      {children}
    </button>
  )
}

function InlineName({
  name,
  disabled,
  muted,
  onSave,
}: {
  name: string
  disabled?: boolean
  muted?: boolean
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
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- React types a key event's target as EventTarget; the handler is on the input itself
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(name)
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- React types a key event's target as EventTarget; the handler is on the input itself
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className={cn(
        'focus-ring block w-full truncate rounded-md bg-transparent text-ui font-medium disabled:opacity-100',
        muted && 'text-graphite',
      )}
    />
  )
}
