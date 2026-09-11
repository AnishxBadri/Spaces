import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { DitherMark, InitialsMark } from '#/components/record/record-parts'
import { badgeStyle, optionColor } from '#/lib/attributes/colors'
import { liveOptions, optionState } from '#/lib/attributes/options'
import { formatDate, formatNumber } from '#/lib/format'
import { listUsers, searchEntities } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * Typed attribute editors — ONE implementation shared by table cells,
 * record rails, and create modals. `variant` only changes chrome:
 * 'cell' is borderless-until-hover; 'field' looks like a form input.
 */

export type RegistryEntry = {
  id?: string
  slug: string
  name: string
  type: string
  options: {
    options?: Array<{
      id: string
      label: string
      group?: string
      color?: string
      archived?: boolean
    }>
    max?: number
    code?: string
    targetKind?: string
    targetObjectId?: string
    multi?: boolean
    required?: boolean
    precision?: number
    default?: unknown
  } | null
  isSystem: boolean
  description?: string | null
}

/** id → display name for reference/actor values, supplied by the caller. */
export type RefNames = Record<string, { name: string } | string>

export function refName(refNames: RefNames | undefined, id: string): string {
  const hit = refNames?.[id]
  if (!hit) return '…'
  return typeof hit === 'string' ? hit : hit.name
}

type Props = {
  def: RegistryEntry
  value: unknown
  onSave: (value: unknown) => void
  variant: 'cell' | 'field'
  autoFocus?: boolean
  /** display names for record/actor reference ids */
  refNames?: RefNames
}

/**
 * Create-dialog layout is type-driven, never hand-placed — the registry
 * generates the form, so the span rule must survive any custom attribute.
 * Half-width is the default; only genuinely long-form fields span both
 * columns. Until a long-text type exists (the expansion path), description
 * is the one long-form field, by convention.
 */
export function fieldSpanClass(def: { type: string; slug: string }): string {
  return def.slug === 'description' ? 'sm:col-span-2' : ''
}

export function optionLabel(def: RegistryEntry, id: unknown): string {
  return optionState(def, id).label
}

export { liveOptions, optionState }

/**
 * The one chip for a select/status/multi_select value. Archived options
 * lose their hue and gain a tooltip rather than disappearing — the
 * deliberate deviation from Attio (spec §3).
 */
export function OptionChip({
  def,
  id,
  className,
}: {
  def: RegistryEntry
  id: unknown
  className?: string
}) {
  const state = optionState(def, id)
  return (
    <span
      style={
        state.archived
          ? undefined
          : badgeStyle(optionColor(state.option, state.index))
      }
      title={state.archived ? 'Archived option' : undefined}
      className={cn(
        'truncate px-1.5 py-0.5 mono text-micro font-medium',
        state.archived && 'bg-bone text-graphite',
        className,
      )}
    >
      {state.label}
    </span>
  )
}

export function ValueEditor({
  def,
  value,
  onSave,
  variant,
  autoFocus,
  refNames,
}: Props) {
  switch (def.type) {
    case 'record_reference':
      return (
        <RecordRefPicker
          def={def}
          value={value}
          onSave={onSave}
          variant={variant}
          refNames={refNames}
        />
      )
    case 'actor_reference':
      return (
        <ActorPicker
          def={def}
          value={value}
          onSave={onSave}
          variant={variant}
          refNames={refNames}
        />
      )
    case 'status':
      // Never edited in a cell: the stage log needs a reason, so M opens
      // Move stage on the record. Here it only reads.
      return (
        <span
          className={cn(
            'flex min-w-0 items-center',
            variant === 'field' ? 'h-8 px-2' : 'h-full px-1',
          )}
          title="Move stage from the record (M)"
        >
          {value == null || value === '' ? (
            <span className="text-ui text-graphite">—</span>
          ) : (
            <OptionChip def={def} id={value} />
          )}
        </span>
      )
    case 'select':
      return (
        <OptionPicker
          def={def}
          value={value}
          onSave={onSave}
          variant={variant}
          multi={false}
        />
      )
    case 'multi_select':
      return (
        <OptionPicker
          def={def}
          value={value}
          onSave={onSave}
          variant={variant}
          multi
        />
      )
    case 'checkbox':
      return (
        <button
          type="button"
          role="checkbox"
          aria-checked={Boolean(value)}
          aria-label={def.name}
          onClick={() => onSave(!value)}
          className={cn(
            'focus-ring flex size-3.5 items-center justify-center border transition-colors duration-150 ease-out-quart',
            variant === 'field' && 'ml-2',
            value
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-hairline bg-paper',
          )}
        >
          {value ? <Check className="size-2.5" strokeWidth={3} /> : null}
        </button>
      )
    case 'rating': {
      const max = def.options?.max ?? 5
      const current = typeof value === 'number' ? value : 0
      return (
        // Squares, not stars: ink for the rating, outlined for the rest,
        // pine while a hover previews.
        <div
          className={cn(
            'flex items-center gap-2',
            variant === 'field' && 'h-8 px-2',
          )}
          role="radiogroup"
          aria-label={def.name}
        >
          <span className="flex items-center gap-0.5">
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={current === n}
                aria-label={`${n} of ${max}`}
                onClick={() => onSave(current === n ? null : n)}
                className="focus-ring flex size-3 items-center justify-center"
              >
                <span
                  className={cn(
                    'block size-2 transition-colors duration-150',
                    n <= current
                      ? 'bg-hairline'
                      : 'border border-hairline bg-paper',
                    'hover:border-primary hover:bg-primary',
                  )}
                />
              </button>
            ))}
          </span>
          <span className="mono text-micro text-graphite">
            {current > 0 ? `${current}/${max}` : '—'}
          </span>
        </div>
      )
    }
    case 'date':
      return variant === 'cell' ? (
        <DateCellEditor
          def={def}
          value={value}
          onSave={onSave}
          variant={variant}
        />
      ) : (
        <TextLikeEditor
          def={def}
          value={value}
          onSave={onSave}
          variant={variant}
          autoFocus={autoFocus}
        />
      )
    default:
      return (
        <TextLikeEditor
          def={def}
          value={value}
          onSave={onSave}
          variant={variant}
          autoFocus={autoFocus}
        />
      )
  }
}

/**
 * A date cell reads as a date until you edit it. `<input type="date">` renders
 * its own `mm/dd/yyyy` skeleton and picker glyph in every empty row, which puts
 * a US-format placeholder and a stray icon in a column where every other empty
 * cell is an em dash — two conventions broken at once. In a form field the
 * native control is exactly right, so this only applies to cells.
 */
function DateCellEditor({ def, value, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const stored = value == null ? '' : String(value)

  if (editing) {
    return (
      <input
        type="date"
        defaultValue={stored}
        autoFocus
        aria-label={def.name}
        onBlur={(e) => {
          setEditing(false)
          if (e.target.value !== stored) onSave(e.target.value || null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="focus-ring-inset h-full w-full min-w-0 rounded-md bg-transparent px-1 text-ui"
      />
    )
  }

  return (
    <button
      type="button"
      aria-label={def.name}
      onClick={() => setEditing(true)}
      className={cn(
        'focus-ring-inset h-full w-full rounded-md px-1 text-ui',
        stored ? 'numeric' : 'text-left text-graphite',
      )}
    >
      {stored ? formatDate(stored) : '—'}
    </button>
  )
}

function TextLikeEditor({ def, value, onSave, variant, autoFocus }: Props) {
  const display = value == null ? '' : String(value)
  const [draft, setDraft] = useState(display)
  const [focused, setFocused] = useState(false)
  const committed = useRef(display)
  useEffect(() => {
    setDraft(display)
    committed.current = display
  }, [display])
  // A number with a precision setting reads formatted (grouping, fixed
  // decimals) until it's being edited; the stored number is untouched.
  const precision = def.type === 'number' ? def.options?.precision : undefined
  const formatted = precision !== undefined && !focused

  function commit() {
    if (draft === committed.current) return
    committed.current = draft
    if (draft.trim() === '') return onSave(null)
    if (def.type === 'number' || def.type === 'currency') {
      const n = Number(draft)
      return onSave(Number.isFinite(n) ? n : null)
    }
    onSave(draft.trim())
  }

  const inputType =
    def.type === 'date'
      ? 'date'
      : formatted
        ? 'text'
        : def.type === 'number' || def.type === 'currency'
          ? 'number'
          : 'text'

  return (
    <input
      type={inputType}
      inputMode={def.type === 'number' ? 'decimal' : undefined}
      value={formatted ? formatNumber(draft, precision) : draft}
      autoFocus={autoFocus}
      aria-label={def.name}
      placeholder="—"
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(committed.current)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className={cn(
        'w-full min-w-0 bg-transparent text-ui',
        (def.type === 'number' || def.type === 'currency') && 'numeric',
        variant === 'field'
          ? // At rest it reads as a value; the rule appears on hover, the
            // reticle on focus. ↵ commits, esc reverts.
            'focus-ring h-8 rounded-md border border-transparent px-2 transition-colors hover:border-rule focus:border-rule'
          : // Inset inside a cell: an offset ring would be clipped by the
            // table's scroll container and overlap the neighbouring column.
            'focus-ring-inset h-full rounded-md px-1',
      )}
    />
  )
}

function RecordRefPicker({ def, value, onSave, variant, refNames }: Props) {
  const multi = Boolean(def.options?.multi)
  const targetKind = def.options?.targetKind ?? 'company'
  // A custom-object target: search that object's records, not a kind.
  const targetObjectId = def.options?.targetObjectId
  const selected: Array<string> = multi
    ? Array.isArray(value)
      ? (value as Array<string>)
      : []
    : value == null
      ? []
      : [String(value)]
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<
    Array<{ id: string; name: string; kind: string }>
  >([])

  useEffect(() => {
    if (!query.trim()) return setResults([])
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        const r = await searchEntities({
          data: targetObjectId
            ? { q: query, objectId: targetObjectId }
            : { q: query, kinds: [targetKind as 'company'] },
        })
        if (alive) setResults(r)
      })()
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, targetKind, targetObjectId])

  const targetLabel = targetObjectId ? 'records' : targetKind
  const mark = (name: string) =>
    targetKind === 'person' && !targetObjectId ? (
      <InitialsMark name={name} size="xs" outline />
    ) : (
      <DitherMark size={12} />
    )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={def.name}
        className={cn(
          'group/pick flex min-w-0 items-center gap-1 text-left',
          variant === 'field'
            ? 'focus-ring h-8 w-full rounded-md border border-transparent px-2 transition-colors hover:border-rule data-[state=open]:border-rule'
            : 'focus-ring-inset h-full w-full rounded-md px-1',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {selected.length === 0 ? (
            <span className="text-ui text-graphite">—</span>
          ) : (
            selected.map((id) => (
              <span
                key={id}
                className="flex h-5 items-center gap-1.5 truncate border border-rule bg-paper px-1.5 text-label font-medium"
              >
                {mark(refName(refNames, id))}
                {refName(refNames, id)}
              </span>
            ))
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-graphite opacity-0 transition-opacity group-hover/pick:opacity-100 group-focus-visible/pick:opacity-100 group-data-[state=open]/pick:opacity-100" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <div className="p-1.5">
          <Input
            value={query}
            autoFocus
            placeholder={`Search ${targetLabel}…`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            className="h-7 text-label"
          />
        </div>
        {results.map((r) => (
          <DropdownMenuItem
            key={r.id}
            onSelect={() => {
              if (multi) {
                if (!selected.includes(r.id)) onSave([...selected, r.id])
              } else {
                onSave(r.id)
              }
              setQuery('')
            }}
          >
            {mark(r.name)}
            {r.name}
          </DropdownMenuItem>
        ))}
        {selected.length > 0 ? (
          <DropdownMenuItem
            onSelect={() => onSave(null)}
            className={cn(
              'text-graphite',
              def.options?.required && !multi && 'hidden',
            )}
          >
            Clear
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ActorPicker({ def, value, onSave, variant, refNames }: Props) {
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([])
  const selected = value == null ? null : String(value)

  return (
    <DropdownMenu
      onOpenChange={async (open) => {
        if (open && users.length === 0) setUsers(await listUsers())
      }}
    >
      <DropdownMenuTrigger
        aria-label={def.name}
        className={cn(
          'group/pick flex min-w-0 items-center gap-1 text-left',
          variant === 'field'
            ? 'focus-ring h-8 w-full rounded-md border border-transparent px-2 transition-colors hover:border-rule data-[state=open]:border-rule'
            : 'focus-ring-inset h-full w-full rounded-md px-1',
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-ui">
          {selected ? (
            <>
              <InitialsMark name={refName(refNames, selected)} size="xs" />
              <span className="truncate">{refName(refNames, selected)}</span>
            </>
          ) : (
            <span className="text-graphite">—</span>
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-graphite opacity-0 transition-opacity group-hover/pick:opacity-100 group-focus-visible/pick:opacity-100 group-data-[state=open]/pick:opacity-100" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {users.map((u) => (
          <DropdownMenuItem key={u.id} onSelect={() => onSave(u.id)}>
            {u.name}
          </DropdownMenuItem>
        ))}
        {selected ? (
          <DropdownMenuItem
            onSelect={() => onSave(null)}
            className="text-graphite"
          >
            Clear
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OptionPicker({
  def,
  value,
  onSave,
  variant,
  multi,
}: Props & { multi: boolean }) {
  const opts = liveOptions(def)
  const selected: Array<string> = multi
    ? Array.isArray(value)
      ? (value as Array<string>)
      : []
    : value == null
      ? []
      : [String(value)]
  // A held archived tag can only be dropped, never re-asserted: the cleanup
  // path for a multi-select is unchecking it, so it stays in the menu greyed.
  const heldArchived = multi
    ? selected.filter((id) => optionState(def, id).archived)
    : []

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={def.name}
        className={cn(
          'group/pick flex min-w-0 items-center gap-1 text-left',
          variant === 'field'
            ? 'focus-ring h-8 w-full rounded-md border border-transparent px-2 transition-colors hover:border-rule data-[state=open]:border-rule'
            : 'focus-ring-inset h-full w-full rounded-md px-1',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {selected.length === 0 ? (
            <span className="text-ui text-graphite">—</span>
          ) : (
            selected.map((id) => <OptionChip key={id} def={def} id={id} />)
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-graphite opacity-0 transition-opacity group-hover/pick:opacity-100 group-focus-visible/pick:opacity-100 group-data-[state=open]/pick:opacity-100" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {multi
          ? [
              ...opts.map((o) => (
                <DropdownMenuCheckboxItem
                  key={o.id}
                  checked={selected.includes(o.id)}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...selected, o.id]
                      : selected.filter((s) => s !== o.id)
                    onSave(next.length === 0 ? null : next)
                  }}
                >
                  <OptionChip def={def} id={o.id} />
                </DropdownMenuCheckboxItem>
              )),
              ...heldArchived.map((id) => (
                <DropdownMenuCheckboxItem
                  key={id}
                  checked
                  onCheckedChange={() => {
                    const next = selected.filter((s) => s !== id)
                    onSave(next.length === 0 ? null : next)
                  }}
                >
                  <OptionChip def={def} id={id} />
                </DropdownMenuCheckboxItem>
              )),
            ]
          : [
              ...opts.map((o) => (
                <DropdownMenuItem key={o.id} onSelect={() => onSave(o.id)}>
                  <OptionChip def={def} id={o.id} />
                </DropdownMenuItem>
              )),
              selected.length > 0 ? (
                <DropdownMenuItem
                  key="__clear"
                  onSelect={() => onSave(null)}
                  className="text-graphite"
                >
                  Clear
                </DropdownMenuItem>
              ) : null,
            ]}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
