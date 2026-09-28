import { ChevronDown } from 'lucide-react'
import { Command as CommandPrimitive } from 'cmdk'
import { useEffect, useRef, useState } from 'react'
import {
  IDENTITY_KEY_LABELS,
  NEW_ATTRIBUTE_TYPES,
  columnLetter,
  columnName,
  isReferenceType,
  readCell,
  shortRefusal,
  specFor,
} from '@spaces/core/import/mapping'
import { TYPE_LABELS } from '#/components/attributes/registry-list'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { CommandEmpty, CommandGroup } from '#/components/ui/command'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Segmented } from '#/components/ui/segmented'
import { Select, selectClasses } from '#/components/ui/select'
import { cn } from '#/lib/utils'
import type {
  AttributeType,
  CoreIdentityKey,
} from '@spaces/core/attributes/registry'
import type {
  ColumnSpec,
  ColumnTarget,
  ImportDateOrder,
  Mapping,
  MappingAttribute,
  MappingRegistry,
} from '@spaces/core/import/mapping'
import type { ColumnView, ImportMappingView } from '#/lib/import/mapping'

/**
 * The mapping step (SPA-165, import-3): SPA-164's preview grid, where **the
 * column head is the mapping control**. Each head stacks the source header,
 * a picker naming the target and its type, and one mono line — a status
 * square and the parse count, whose click opens the refused rows. Above the
 * grid one bone strip says what the rows match on; below it one mono line
 * says how much of the sheet is on screen. Those two are the only
 * commentary (design contract §1): nothing in a head or a cell explains
 * policy.
 *
 * The picker is the `Select` sheet's anatomy — Radix `Popover` around a cmdk
 * `Command`, paper, 1px ink, 28px rows, bone highlight — with a trigger cut to
 * the head's 28px, because the head needs more than one value per row (the
 * target left, its type in mono right) and a second pane for `+ New
 * attribute`, which `Select` does not carry.
 */

export type NewAttributeDraft = {
  name: string
  type: AttributeType
  options: Array<string>
  dateOrder: ImportDateOrder | null
}

export type PreviewRow = { rowNum: number; cells: Array<string> }

/** Every column is the same width, so the foot line can say what is on screen. */
const COLUMN_PX = 224
const GUTTER_PX = 40

const OPTION_TYPES: ReadonlySet<AttributeType> = new Set([
  'select',
  'multi_select',
  'status',
])

const typeWord = (type: AttributeType) =>
  (TYPE_LABELS[type] ?? type).toLowerCase()

/** An attribute's type in mono: its type word, or what a reference points at. */
function attributeType(a: MappingAttribute, view: ImportMappingView): string {
  return view.references[a.id]?.type ?? typeWord(a.type)
}

function registryOf(view: ImportMappingView): MappingRegistry {
  return {
    attributes: view.attributes,
    identityKeys: view.object.identityKeys,
  }
}

/** What a head's picker reads: the target left, its type in mono right. */
export function targetLabel(
  target: ColumnTarget,
  view: ImportMappingView,
): { name: string; type: string } {
  switch (target.target) {
    case 'name':
      return { name: 'Name', type: 'text' }
    case 'ignore':
      return { name: 'Skip', type: '' }
    case 'identity':
      return { name: IDENTITY_KEY_LABELS[target.key], type: 'identity' }
    case 'new':
      return { name: '+ New', type: typeWord(target.type) }
    // Never on a records batch; the ledger step draws its own targets.
    case 'ledger':
      return { name: 'Event field', type: target.field }
    case 'attribute': {
      const attr = view.attributes.find((a) => a.id === target.attributeId)
      return attr
        ? { name: attr.name, type: attributeType(attr, view) }
        : { name: 'Unavailable', type: '' }
    }
  }
}

function dateOrderOf(target: ColumnTarget): ImportDateOrder | null {
  if (target.target === 'attribute' || target.target === 'new')
    return target.dateOrder ?? null
  return null
}

function isDateTarget(target: ColumnTarget, view: ImportMappingView): boolean {
  if (target.target === 'new') return target.type === 'date'
  if (target.target !== 'attribute') return false
  return view.attributes.some(
    (a) => a.id === target.attributeId && a.type === 'date',
  )
}

// ---------------------------------------------------------------------------
// Identity strip
// ---------------------------------------------------------------------------

/** `Match on Website → domain, then on name.` */
export function identitySentence(
  mapping: Mapping,
  keys: ReadonlyArray<CoreIdentityKey>,
  header: ReadonlyArray<string> | null,
): string {
  const parts = keys.flatMap((key) => {
    const column = mapping.findIndex(
      (t) => t.target === 'identity' && t.key === key,
    )
    if (column === -1) return []
    const h = header?.at(column)?.trim() ?? ''
    return [`${h === '' ? columnLetter(column) : h} → ${key}`]
  })
  return parts.length === 0
    ? 'Match on name.'
    : `Match on ${parts.join(', then on ')}, then on name.`
}

export function IdentityStrip({
  view,
  header,
  disabled,
  onMap,
}: {
  view: ImportMappingView
  header: Array<string> | null
  disabled: boolean
  onMap: (column: number, target: ColumnTarget) => void
}) {
  const keys = view.object.identityKeys
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border border-rule bg-bone px-4">
      <span className="label-caps text-foreground">Identity</span>
      <span className="min-w-0 flex-1 truncate text-ui">
        {identitySentence(view.mapping, keys, header)}
      </span>
      {keys.length > 0 ? (
        <Popover>
          <PopoverTrigger
            disabled={disabled}
            className="focus-ring shrink-0 mono text-micro text-graphite hover:text-foreground disabled:opacity-50"
          >
            change key ›
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-80 flex-col gap-2">
            {keys.map((key) => {
              const held = view.mapping.findIndex(
                (t) => t.target === 'identity' && t.key === key,
              )
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-ui">
                    {IDENTITY_KEY_LABELS[key]}
                  </span>
                  <Select
                    aria-label={`Column for ${IDENTITY_KEY_LABELS[key]}`}
                    width="content"
                    className="min-w-0 flex-1"
                    value={held === -1 ? 'none' : String(held)}
                    items={[
                      { value: 'none', label: 'No column' },
                      ...view.mapping.map((_, i) => ({
                        value: String(i),
                        label: columnName(i, header),
                      })),
                    ]}
                    onChange={(v) => {
                      if (v === 'none') {
                        if (held !== -1) onMap(held, { target: 'ignore' })
                        return
                      }
                      onMap(Number(v), { target: 'identity', key })
                    }}
                  />
                </div>
              )
            })}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The head's picker
// ---------------------------------------------------------------------------

const ITEM = selectClasses({ width: 'content' }).item

function PickerRow({
  value,
  name,
  type,
  current,
  onSelect,
}: {
  value: string
  name: string
  type: string
  current: boolean
  onSelect: () => void
}) {
  return (
    <CommandPrimitive.Item
      value={value}
      keywords={[name, type]}
      onSelect={onSelect}
      className={cn(ITEM, current && 'font-medium')}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {type ? (
        <span className="shrink-0 mono text-micro text-graphite">{type}</span>
      ) : null}
    </CommandPrimitive.Item>
  )
}

function DateOrderChoice({
  value,
  onChange,
  disabled,
}: {
  value: ImportDateOrder | null
  onChange: (order: ImportDateOrder) => void
  disabled: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-rule px-2.5 py-2">
      <span className="field-label text-graphite">Dates</span>
      <Segmented
        size="sm"
        label="Date order"
        disabled={disabled}
        value={value ?? 'none'}
        options={[
          { id: 'dmy', label: 'Day first' },
          { id: 'mdy', label: 'Month first' },
        ]}
        onChange={(id) => {
          if (id !== 'none') onChange(id)
        }}
      />
    </div>
  )
}

/** A record reference column's toggle: a cell that names nothing plans one. */
function CreateMissingChoice({
  plural,
  checked,
  onChange,
  disabled,
}: {
  plural: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled: boolean
}) {
  return (
    <label className="flex h-9 shrink-0 cursor-pointer items-center gap-2 border-t border-rule px-2.5">
      <Checkbox
        checked={checked}
        disabled={disabled}
        aria-label={`Create missing ${plural.toLowerCase()}`}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span className="text-ui">Create missing {plural.toLowerCase()}</span>
    </label>
  )
}

function NewAttributePane({
  view,
  column,
  header,
  draft,
  pending,
  onDraft,
  onCreate,
  onBack,
}: {
  view: ImportMappingView
  column: ColumnView
  header: string
  draft: ColumnTarget
  pending: boolean
  onDraft: (next: {
    name: string
    type: AttributeType
    options: Array<string>
  }) => void
  onCreate: (draft: NewAttributeDraft) => void
  onBack: () => void
}) {
  const fromDraft = draft.target === 'new' ? draft : null
  const [name, setName] = useState(fromDraft?.name ?? (header || 'New field'))
  const [type, setType] = useState<AttributeType | ''>(fromDraft?.type ?? '')
  const [order, setOrder] = useState<ImportDateOrder | null>(
    fromDraft?.dateOrder ?? null,
  )
  const offered =
    type === 'multi_select' ? column.labels.multi : column.labels.select
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set())
  const options = offered.filter((l) => !dropped.has(l))
  const isOptions = type !== '' && OPTION_TYPES.has(type)
  const ready =
    name.trim() !== '' && type !== '' && (!isOptions || options.length > 0)

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-new-name">Name</Label>
          <Input
            id="import-new-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (type !== '') onDraft({ name: name.trim(), type, options })
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-new-type">Type</Label>
          <Select
            id="import-new-type"
            aria-label="Type"
            width="content"
            placeholder="Choose a type"
            value={type}
            items={NEW_ATTRIBUTE_TYPES.map((t) => ({
              value: t,
              label: TYPE_LABELS[t] ?? t,
            }))}
            onChange={(t) => {
              setType(t)
              const next =
                t === 'multi_select'
                  ? column.labels.multi
                  : column.labels.select
              onDraft({
                name: name.trim() || header,
                type: t,
                options: OPTION_TYPES.has(t)
                  ? next.filter((l) => !dropped.has(l))
                  : [],
              })
            }}
          />
        </div>
        {isOptions ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span className="field-label text-graphite">Options</span>
              <span className="tabular mono text-micro text-graphite">
                {options.length} of {offered.length}
              </span>
            </div>
            <div className="flex max-h-40 flex-col overflow-y-auto border border-rule">
              {offered.length === 0 ? (
                <span className="px-2.5 py-2 text-label text-graphite">
                  No values in this column
                </span>
              ) : (
                offered.map((label, i) => {
                  const on = !dropped.has(label)
                  return (
                    <label
                      key={label}
                      className="flex h-7 shrink-0 cursor-pointer items-center gap-2 px-2.5 hover:bg-bone"
                    >
                      <Checkbox
                        checked={on}
                        aria-label={label}
                        onCheckedChange={(next) => {
                          const s = new Set(dropped)
                          if (next) s.delete(label)
                          else s.add(label)
                          setDropped(s)
                        }}
                      />
                      <Badge option={undefined} index={i} unselected={!on}>
                        {label}
                      </Badge>
                    </label>
                  )
                })
              )}
            </div>
          </div>
        ) : null}
      </div>
      {type === 'date' ? (
        <DateOrderChoice value={order} onChange={setOrder} disabled={pending} />
      ) : null}
      <div className="flex h-13 shrink-0 items-center gap-2 border-t border-hairline bg-bone px-3">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={pending}>
          Back
        </Button>
        <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
          adds to {view.object.plural.toLowerCase()}
        </span>
        <Button
          size="sm"
          disabled={!ready}
          pending={pending}
          onClick={() => {
            if (type === '') return
            onCreate({
              name: name.trim(),
              type,
              options: isOptions ? options : [],
              dateOrder: type === 'date' ? order : null,
            })
          }}
        >
          Create attribute
        </Button>
      </div>
    </div>
  )
}

function TargetPicker({
  view,
  index,
  header,
  column,
  target,
  disabled,
  onMap,
  onCreate,
}: {
  view: ImportMappingView
  index: number
  header: Array<string> | null
  column: ColumnView
  target: ColumnTarget
  disabled: boolean
  onMap: (column: number, target: ColumnTarget) => Promise<void>
  onCreate: (column: number, draft: NewAttributeDraft) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'list' | 'new'>('list')
  const [pending, setPending] = useState(false)
  const sheet = useRef<HTMLDivElement>(null)
  const label = targetLabel(target, view)
  const headerText = header?.at(index)?.trim() ?? ''
  // A record reference column names the object a missing record is made in.
  const createsIn =
    target.target === 'attribute' &&
    view.attributes.some(
      (a) => a.id === target.attributeId && a.type === 'record_reference',
    )
      ? (view.references[target.attributeId]?.plural ?? null)
      : null
  const current =
    target.target === 'attribute'
      ? `attribute:${target.attributeId}`
      : target.target === 'identity'
        ? `identity:${target.key}`
        : target.target

  function choose(next: ColumnTarget) {
    setOpen(false)
    void onMap(index, next)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setPane(target.target === 'new' ? 'new' : 'list')
      }}
    >
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={`Map column ${columnName(index, header)}`}
        className={cn(
          'focus-ring-inset flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border px-2 text-left text-ui transition-colors duration-150 ease-out-quart disabled:opacity-50',
          target.target === 'ignore'
            ? 'border-dashed border-rule bg-bone text-graphite'
            : target.target === 'new'
              ? 'border-primary bg-selected'
              : 'border-hairline bg-paper',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label.name}</span>
        {label.type ? (
          <span className="shrink-0 mono text-micro text-graphite">
            {label.type}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden
          className="size-3 shrink-0 text-graphite"
          strokeWidth={2}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-80 p-0"
        onOpenAutoFocus={(e) => {
          if (pane === 'new') return
          e.preventDefault()
          sheet.current?.querySelector('input')?.focus()
        }}
      >
        {pane === 'new' ? (
          <NewAttributePane
            view={view}
            column={column}
            header={headerText}
            draft={target}
            pending={pending}
            onBack={() => setPane('list')}
            onDraft={(d) =>
              void onMap(index, {
                target: 'new',
                name: d.name || headerText || 'New field',
                type: d.type,
                ...(d.options.length > 0 ? { options: d.options } : {}),
              })
            }
            onCreate={(d) => {
              setPending(true)
              void onCreate(index, d).finally(() => {
                setPending(false)
                setOpen(false)
              })
            }}
          />
        ) : (
          <CommandPrimitive
            ref={sheet}
            label={`Target for ${columnName(index, header)}`}
            defaultValue={current}
            loop
            className="flex max-h-96 flex-col"
          >
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule px-2.5">
              <span aria-hidden className="mono text-micro text-primary">
                ›
              </span>
              <CommandPrimitive.Input
                placeholder="Search fields…"
                aria-label="Search fields"
                className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-graphite"
              />
            </div>
            <CommandPrimitive.List className="min-h-0 flex-1 overflow-y-auto p-1">
              <CommandEmpty>No field matches.</CommandEmpty>
              <CommandGroup heading="Record">
                <PickerRow
                  value="name"
                  name="Name"
                  type="text"
                  current={target.target === 'name'}
                  onSelect={() => choose({ target: 'name' })}
                />
              </CommandGroup>
              {view.object.identityKeys.length > 0 ? (
                <CommandGroup heading="Identity">
                  {view.object.identityKeys.map((key) => (
                    <PickerRow
                      key={key}
                      value={`identity:${key}`}
                      name={IDENTITY_KEY_LABELS[key]}
                      type="identity"
                      current={
                        target.target === 'identity' && target.key === key
                      }
                      onSelect={() => choose({ target: 'identity', key })}
                    />
                  ))}
                </CommandGroup>
              ) : null}
              {view.attributes.length > 0 ? (
                <CommandGroup heading="Attributes">
                  {view.attributes.map((a) => (
                    <PickerRow
                      key={a.id}
                      value={`attribute:${a.id}`}
                      name={a.name}
                      type={attributeType(a, view)}
                      current={
                        target.target === 'attribute' &&
                        target.attributeId === a.id
                      }
                      onSelect={() =>
                        choose({ target: 'attribute', attributeId: a.id })
                      }
                    />
                  ))}
                </CommandGroup>
              ) : null}
              <CommandGroup>
                <PickerRow
                  value="new"
                  name="+ New attribute"
                  type=""
                  current={target.target === 'new'}
                  onSelect={() => setPane('new')}
                />
                <PickerRow
                  value="ignore"
                  name="Skip"
                  type=""
                  current={target.target === 'ignore'}
                  onSelect={() => choose({ target: 'ignore' })}
                />
              </CommandGroup>
            </CommandPrimitive.List>
            {isDateTarget(target, view) && target.target === 'attribute' ? (
              <DateOrderChoice
                value={dateOrderOf(target)}
                disabled={disabled}
                onChange={(dateOrder) =>
                  void onMap(index, { ...target, dateOrder })
                }
              />
            ) : null}
            {target.target === 'attribute' && createsIn !== null ? (
              <CreateMissingChoice
                plural={createsIn}
                checked={target.createMissing === true}
                disabled={disabled}
                onChange={(on) =>
                  void onMap(
                    index,
                    on
                      ? { ...target, createMissing: true }
                      : {
                          target: 'attribute',
                          attributeId: target.attributeId,
                        },
                  )
                }
              />
            ) : null}
          </CommandPrimitive>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------

const STATUS_INK = {
  ok: 'text-success',
  warn: 'text-warning',
  fail: 'text-destructive',
} as const

function ParseCount({
  index,
  header,
  column,
}: {
  index: number
  header: Array<string> | null
  column: ColumnView
}) {
  if (column.parsed === null || column.status === null)
    return <span className="h-4" />
  const line = (
    <>
      <span aria-hidden className="size-1.5 shrink-0 bg-current" />
      <span className="tabular">
        {column.parsed.toLocaleString('en-US')} of{' '}
        {column.total.toLocaleString('en-US')}
        {column.unit === 'found' ? ' found' : ''}
      </span>
    </>
  )
  const ink = STATUS_INK[column.status]
  if (column.failureCount === 0)
    return (
      <span
        className={cn('flex h-4 items-center gap-1.5 mono text-micro', ink)}
      >
        {line}
      </span>
    )
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'focus-ring-inset flex h-4 w-fit items-center gap-1.5 mono text-micro hover:underline',
          ink,
        )}
        aria-label={`Rows that do not read in ${columnName(index, header)}`}
      >
        {line}
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-96 flex-col gap-2 p-0">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule px-3">
          <span className="label-caps text-foreground">
            {column.unit === 'found' ? 'Not found' : 'Refused'}
          </span>
          <span className="tabular mono text-micro text-graphite">
            {column.failureCount.toLocaleString('en-US')} ·{' '}
            {columnName(index, header)}
          </span>
        </div>
        <ol className="flex max-h-72 flex-col overflow-y-auto pb-1">
          {column.failures.map((f) => (
            <li
              key={f.rowNum}
              className="flex min-h-7 items-baseline gap-3 px-3 py-1"
            >
              <span className="tabular w-10 shrink-0 text-right mono text-micro text-graphite">
                {f.rowNum}
              </span>
              <span className="min-w-0 flex-1 text-label">{f.reason}</span>
            </li>
          ))}
          {column.failureCount > column.failures.length ? (
            <li className="px-3 py-1 mono text-micro text-graphite">
              + {column.failureCount - column.failures.length} more
            </li>
          ) : null}
        </ol>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// The cells
// ---------------------------------------------------------------------------

function SampleCell({ spec, raw }: { spec: ColumnSpec | null; raw: string }) {
  if (spec === null || raw.trim() === '') return <>{raw}</>
  // A reference is looked up, not read — its head carries the count.
  if (spec.kind === 'typed' && isReferenceType(spec.type)) return <>{raw}</>
  const out = readCell(spec, raw)
  if (spec.kind === 'typed' && OPTION_TYPES.has(spec.type)) {
    const options = spec.options.options ?? []
    if (!out.ok)
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-graphite">{raw}</span>
          <span className="shrink-0 mono text-micro text-graphite">→</span>
          <span className="shrink-0 text-warning">pick an option</span>
        </span>
      )
    const ids = Array.isArray(out.value) ? out.value : [String(out.value)]
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-graphite">{raw}</span>
        <span className="shrink-0 mono text-micro text-graphite">→</span>
        {ids.map((id) => {
          const i = options.findIndex((o) => o.id === id)
          const option = options.at(i)
          return (
            <Badge key={id} option={option} index={Math.max(i, 0)}>
              {option?.label ?? id}
            </Badge>
          )
        })}
      </span>
    )
  }
  if (out.ok) return <>{raw}</>
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 mono text-micro text-destructive">
        {shortRefusal(spec)}
      </span>
      <span className="truncate text-graphite line-through">{raw}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** Which columns the scroll box shows, from its offset — every column is one width. */
function visibleRange(
  scrollLeft: number,
  clientWidth: number,
  count: number,
): { first: number; last: number } {
  const left = Math.max(0, scrollLeft - GUTTER_PX)
  const right = scrollLeft + clientWidth - GUTTER_PX
  const first = Math.min(count, Math.ceil(left / COLUMN_PX))
  const last = Math.min(count, Math.floor(right / COLUMN_PX)) - 1
  return { first, last: Math.max(first - 1, last) }
}

export function footLine(
  shown: number,
  rowCount: number,
  columnCount: number,
  range: { first: number; last: number } | null,
): string {
  const rows = `${shown} of ${rowCount.toLocaleString('en-US')} rows`
  if (range === null) return `${rows} · ${columnCount} columns`
  const visible = Math.max(0, range.last - range.first + 1)
  const parts = [rows, `${visible} of ${columnCount} columns`]
  if (range.first > 0)
    parts.push(
      `scroll ← for ${columnLetter(0)}–${columnLetter(range.first - 1)}`,
    )
  if (range.last < columnCount - 1)
    parts.push(
      `scroll → for ${columnLetter(range.last + 1)}–${columnLetter(columnCount - 1)}`,
    )
  return parts.join(' · ')
}

export function MappingGrid({
  view,
  header,
  rows,
  rowCount,
  disabled,
  onMap,
  onCreate,
}: {
  view: ImportMappingView
  header: Array<string> | null
  rows: Array<PreviewRow>
  rowCount: number
  disabled: boolean
  onMap: (column: number, target: ColumnTarget) => Promise<void>
  onCreate: (column: number, draft: NewAttributeDraft) => Promise<void>
}) {
  const registry = registryOf(view)
  const specs = view.mapping.map((t) => specFor(t, registry))
  const count = view.mapping.length
  const box = useRef<HTMLDivElement>(null)
  // Null until measured, on the server and the first client render alike.
  const [range, setRange] = useState<{ first: number; last: number } | null>(
    null,
  )

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () =>
      setRange(visibleRange(el.scrollLeft, el.clientWidth, count))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    el.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', measure)
    }
  }, [count])

  return (
    <section className="flex min-h-0 flex-col gap-2">
      <div
        ref={box}
        className="isolate min-h-0 overflow-auto border border-rule"
      >
        <table
          className="table-fixed border-collapse text-ui"
          aria-label="Column mapping"
        >
          <thead className="sticky top-0 z-10 bg-paper">
            <tr className="border-b border-hairline">
              <th className="w-10 min-w-10 border-r border-rule" />
              {view.mapping.map((target, i) => (
                <th
                  key={i}
                  scope="col"
                  className={cn(
                    'h-23 w-56 max-w-56 min-w-56 border-r border-rule px-2 py-2 text-left align-top font-normal last:border-r-0',
                    target.target === 'ignore' && 'bg-bone',
                  )}
                >
                  <div className="flex h-full flex-col justify-between gap-1.5">
                    <span className="truncate mono text-label text-graphite">
                      {columnName(i, header)}
                    </span>
                    <TargetPicker
                      view={view}
                      index={i}
                      header={header}
                      column={view.columns[i]}
                      target={target}
                      disabled={disabled}
                      onMap={onMap}
                      onCreate={onCreate}
                    />
                    <ParseCount
                      index={i}
                      header={header}
                      column={view.columns[i]}
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rowNum} className="h-row border-b border-rule">
                <td className="tabular w-10 min-w-10 border-r border-rule px-2 text-right mono text-micro text-graphite">
                  {row.rowNum}
                </td>
                {view.mapping.map((target, i) => {
                  const raw = row.cells.at(i) ?? ''
                  return (
                    <td
                      key={i}
                      title={raw}
                      className={cn(
                        'w-56 max-w-56 truncate border-r border-rule px-2 align-middle whitespace-nowrap last:border-r-0',
                        target.target === 'ignore' && 'bg-bone',
                      )}
                    >
                      <SampleCell spec={specs[i]} raw={raw} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tabular mono text-micro text-graphite">
        {footLine(rows.length, rowCount, count, range)}
      </p>
    </section>
  )
}
