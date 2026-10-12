import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { readAiConfig } from '@spaces/core/ai/attribute-ai'
import { AttributeDialog } from './attribute-dialog'
import { SettingsGroupHead } from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { reorderAttributes, updateAttribute } from '#/lib/server-fns'
import type { listRegistry } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * One object's registry as a settings ledger (spec §7): `ATTRIBUTES` with
 * the live count and `drag to reorder` in its head, then one row per
 * attribute — grip · name · type in words (`Multi-select · 6`,
 * `Record · People`) · rules (`↔ Team · N:N`, `identity · unique`,
 * `filled by Apollo`) ·
 * `···` (Edit, Move up, Move down, Archive).
 * Drag or the menu's moves persist sort_order, which every table and rail
 * reads. Archived attributes wait in a collapsed group below — never
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
  record_reference: 'Record',
  actor_reference: 'User',
}

/** A core kind's list name, for `Record · People`. */
const KIND_PLURAL: Record<string, string> = {
  company: 'Companies',
  person: 'People',
  deal: 'Deals',
}

/**
 * An attribute's type in words: the type, then what it holds when that
 * matters — its live options, the object it points at, its currency.
 * `objectNames` maps an object row's id to its plural.
 */
export function typeWords(
  attr: Pick<RegistryAttr, 'type' | 'options'>,
  objectNames: ReadonlyMap<string, string>,
): string {
  const label = TYPE_LABELS[attr.type] ?? attr.type
  const stored = attr.options
  switch (attr.type) {
    case 'select':
    case 'multi_select':
    case 'status':
      return `${label} · ${(stored.options ?? []).filter((o) => o.archived !== true).length}`
    case 'record_reference': {
      const target =
        stored.targetObjectId === undefined
          ? stored.targetKind === undefined
            ? undefined
            : KIND_PLURAL[stored.targetKind]
          : objectNames.get(stored.targetObjectId)
      return target === undefined ? label : `${label} · ${target}`
    }
    case 'currency':
      return `${label} · ${stored.code ?? 'USD'}`
    default:
      return label
  }
}

/**
 * An attribute's rules in words: its relationship pair (`↔ Team · N:N`,
 * `· pair archived` once the other half is, D69), required, an identity key (unique by construction, D75), the
 * enrichment source that fills it, an AI answer. `filledBy` is the source's
 * name, or null when none fills it.
 */
export function ruleWords(
  attr: Pick<RegistryAttr, 'type' | 'options' | 'archived' | 'pair'>,
  filledBy: string | null,
): string {
  const stored = attr.options
  return [
    attr.pair === null
      ? null
      : [
          `↔ ${attr.pair.name}`,
          stored.cardinality ?? null,
          attr.pair.archived ? 'pair archived' : null,
        ]
          .filter((w) => w !== null)
          .join(' · '),
    stored.required ? 'required' : null,
    stored.identityKey === undefined ? null : 'identity · unique',
    filledBy === null ? null : `filled by ${filledBy}`,
    readAiConfig(attr) === null ? null : 'AI answers',
    attr.archived ? 'values kept' : null,
  ]
    .filter((w) => w !== null)
    .join(' · ')
}

/** The record kind whose vocabulary Fill from offers: Companies and People only. (D76) */
const fillFromOf = (object: ObjectRow): 'company' | 'person' | undefined =>
  !object.isSystem
    ? undefined
    : object.slug === 'companies'
      ? 'company'
      : object.slug === 'people'
        ? 'person'
        : undefined

function moveItem<T>(list: Array<T>, from: number, to: number): Array<T> {
  if (to < 0 || to >= list.length || from === to) return list
  const next = [...list]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row)
  return next
}

// The lanes, shared by the head and every row so they stay one grid.
const LANE = {
  grip: 'w-4 shrink-0',
  type: 'w-36 shrink-0',
  rules: 'w-44 shrink-0 max-md:hidden',
  actions: 'flex w-18 shrink-0 justify-end',
} as const

export function RegistryList({
  object,
  registry,
  canReshape,
  objectNames,
  filledBy,
}: {
  object: ObjectRow
  registry: Array<RegistryAttr>
  canReshape: boolean
  /** Object row id → plural, for a relationship's target. */
  objectNames: ReadonlyMap<string, string>
  /** Attribute id → the enrichment source that fills it. */
  filledBy: ReadonlyMap<string, string>
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

  const words = (attr: RegistryAttr) => ({
    type: typeWords(attr, objectNames),
    rules: ruleWords(attr, filledBy.get(attr.id) ?? null),
  })

  return (
    <div className="flex flex-col">
      <section className="flex flex-col">
        <SettingsGroupHead
          title="Attributes"
          action={
            canReshape && ordered.length > 1
              ? `${ordered.length} · drag to reorder`
              : String(ordered.length)
          }
        />
        <div
          aria-hidden
          className="flex h-8 items-center gap-3 border-b border-hairline field-label leading-4 text-graphite"
        >
          <span className={LANE.grip} />
          <span className="min-w-0 flex-1">Attribute</span>
          <span className={LANE.type}>Type</span>
          <span className={LANE.rules}>Rules</span>
          <span className={LANE.actions} />
        </div>
        <ol aria-label={`${object.plural} attributes`}>
          {ordered.map((attr, idx) => (
            <AttributeRow
              key={attr.id}
              attr={attr}
              words={words(attr)}
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
              No attributes yet.
            </li>
          ) : null}
        </ol>
      </section>

      {archived.length > 0 ? (
        <section className="flex flex-col pt-7">
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className="focus-ring-inset flex items-baseline gap-2 border-b border-hairline pb-1.5 text-left"
          >
            <span className="w-3 mono text-micro text-graphite">
              {showArchived ? '⌄' : '›'}
            </span>
            <span className="label-caps leading-3.5 text-graphite">
              Archived
            </span>
            <span className="mono text-micro text-graphite">
              {archived.length}
            </span>
          </button>
          {showArchived ? (
            <ol aria-label={`${object.plural} archived attributes`}>
              {archived.map((attr) => (
                <AttributeRow
                  key={attr.id}
                  attr={attr}
                  words={words(attr)}
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
  words,
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
  words: { type: string; rules: string }
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

  const verbs: Array<RowVerb> = [
    { label: 'Edit…', onSelect: () => setEditing(true) },
    ...(onMove === undefined
      ? []
      : [
          {
            label: 'Move up',
            disabled: isFirst,
            onSelect: () => onMove('up'),
          },
          {
            label: 'Move down',
            disabled: isLast,
            onSelect: () => onMove('down'),
          },
        ]),
    {
      label: 'Archive',
      onSelect: () => void act({ archived: true }, `${attr.name} archived`),
    },
  ]

  return (
    <li
      data-attribute={attr.slug}
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
        'flex h-ledger-row items-center gap-3 border-b border-rule transition-[background-color,opacity] duration-150 ease-out-quart',
        dragging && 'opacity-50',
        over && 'bg-bone',
      )}
    >
      <span
        aria-hidden
        className={cn(
          LANE.grip,
          'mono text-micro',
          onDragStart && draggable
            ? 'cursor-grab touch-none text-graphite active:cursor-grabbing'
            : 'text-transparent',
        )}
      >
        ⋮⋮
      </span>

      <span className="min-w-0 flex-1">
        <InlineName
          name={attr.name}
          disabled={!canReshape}
          muted={attr.archived}
          onSave={(name) => act({ name })}
        />
      </span>

      <span
        data-type
        className={cn(LANE.type, 'truncate text-ui text-graphite')}
      >
        {words.type}
      </span>

      <span data-rules className={cn(LANE.rules, 'truncate text-label')}>
        {words.rules}
      </span>

      <span className={LANE.actions}>
        {attr.archived ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canReshape}
            onClick={() => act({ archived: false }, `${attr.name} restored`)}
          >
            Restore
          </Button>
        ) : canReshape ? (
          <RowMenu name={attr.name} verbs={verbs} />
        ) : null}
      </span>

      <AttributeDialog
        mode="edit"
        attr={attr}
        objectId={object.id}
        objectLabel={object.singular}
        objectPlural={object.plural}
        fillFrom={fillFromOf(object)}
        open={editing}
        onOpenChange={setEditing}
        onSaved={() => router.invalidate()}
      />
    </li>
  )
}

type RowVerb = {
  label: string
  disabled?: boolean
  /** Runs once the menu has closed, so a window it opens keeps its focus. */
  onSelect: () => void
}

/** A row's `···`: its verbs in a menu, the one that opens a window run after close. */
function RowMenu({
  name,
  verbs,
}: {
  name: string
  verbs: ReadonlyArray<RowVerb>
}) {
  const afterClose = useRef<(() => void) | null>(null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`More for ${name}`}>
          <span aria-hidden className="mono text-ui text-graphite">
            ···
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-40"
        onCloseAutoFocus={(e) => {
          const run = afterClose.current
          if (run === null) return
          e.preventDefault()
          afterClose.current = null
          run()
        }}
      >
        {verbs.map((v) => (
          <DropdownMenuItem
            key={v.label}
            disabled={v.disabled === true}
            onSelect={() => {
              afterClose.current = v.onSelect
            }}
          >
            {v.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
