import { Building2, Check, ChevronDown, Star, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { badgeStyle, optionColor } from '#/lib/attributes/colors'
import { formatDate } from '#/lib/format'
import { listUsers, searchEntities } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * Typed attribute editors — ONE implementation shared by table cells,
 * record rails, and create modals. `variant` only changes chrome:
 * 'cell' is borderless-until-hover; 'field' looks like a form input.
 */

export type RegistryEntry = {
  slug: string
  name: string
  type: string
  options: {
    options?: Array<{
      id: string
      label: string
      group?: string
      color?: string
    }>
    max?: number
    code?: string
    targetKind?: string
    multi?: boolean
    required?: boolean
  } | null
  isSystem: boolean
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

export function optionLabel(def: RegistryEntry, id: unknown): string {
  const opt = def.options?.options?.find((o) => o.id === id)
  return opt?.label ?? String(id ?? '')
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
    case 'select':
    case 'status':
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
            'flex size-4 items-center justify-center rounded border transition-colors duration-150 ease-out-quart focus-ring',
            value
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input hover:border-ring',
          )}
        >
          {value ? <Check className="size-3" strokeWidth={3} /> : null}
        </button>
      )
    case 'rating': {
      const max = def.options?.max ?? 5
      const current = typeof value === 'number' ? value : 0
      return (
        <div
          className="flex items-center gap-0.5"
          role="radiogroup"
          aria-label={def.name}
        >
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={current === n}
              aria-label={`${n} of ${max}`}
              onClick={() => onSave(current === n ? null : n)}
              className="rounded focus-ring"
            >
              <Star
                className={cn(
                  'size-3.5',
                  n <= current
                    ? 'fill-primary text-primary'
                    : 'text-border hover:text-muted-foreground',
                )}
                strokeWidth={1.75}
              />
            </button>
          ))}
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
        className="focus-ring-inset h-full w-full min-w-0 rounded bg-transparent px-1 text-ui"
      />
    )
  }

  return (
    <button
      type="button"
      aria-label={def.name}
      onClick={() => setEditing(true)}
      className={cn(
        'focus-ring-inset h-full w-full rounded px-1 text-ui',
        stored ? 'numeric' : 'text-left text-muted-foreground',
      )}
    >
      {stored ? formatDate(stored) : '—'}
    </button>
  )
}

function TextLikeEditor({ def, value, onSave, variant, autoFocus }: Props) {
  const display = value == null ? '' : String(value)
  const [draft, setDraft] = useState(display)
  const committed = useRef(display)
  useEffect(() => {
    setDraft(display)
    committed.current = display
  }, [display])

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
      : def.type === 'number' || def.type === 'currency'
        ? 'number'
        : 'text'

  return (
    <input
      type={inputType}
      value={draft}
      autoFocus={autoFocus}
      aria-label={def.name}
      placeholder="—"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
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
          ? 'focus-ring border-input h-8 rounded-md border px-2.5 shadow-xs'
          : // Inset inside a cell: an offset ring would be clipped by the
            // table's scroll container and overlap the neighbouring column.
            'focus-ring-inset h-full rounded px-1',
      )}
    />
  )
}

function RecordRefPicker({ def, value, onSave, variant, refNames }: Props) {
  const multi = Boolean(def.options?.multi)
  const targetKind = def.options?.targetKind ?? 'company'
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
    const t = setTimeout(async () => {
      const r = await searchEntities({
        data: { q: query, kinds: [targetKind as 'company'] },
      })
      if (alive) setResults(r)
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, targetKind])

  const Icon = targetKind === 'person' ? User : Building2

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={def.name}
        className={cn(
          'flex min-w-0 items-center gap-1 text-left',
          variant === 'field'
            ? 'focus-ring border-input h-8 w-full rounded-md border px-2.5 shadow-xs'
            : 'focus-ring-inset h-full w-full rounded px-1',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {selected.length === 0 ? (
            <span className="text-ui text-muted-foreground">—</span>
          ) : (
            selected.map((id) => (
              <span
                key={id}
                className="flex items-center gap-1 truncate rounded-full bg-muted px-2 py-0.5 text-label font-medium"
              >
                <Icon className="size-2.5 shrink-0" strokeWidth={1.75} />
                {refName(refNames, id)}
              </span>
            ))
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <div className="p-1.5">
          <Input
            value={query}
            autoFocus
            placeholder={`Search ${targetKind}…`}
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
            <Icon
              className="size-3.5 text-muted-foreground"
              strokeWidth={1.75}
            />
            {r.name}
          </DropdownMenuItem>
        ))}
        {selected.length > 0 ? (
          <DropdownMenuItem
            onSelect={() => onSave(null)}
            className={cn(
              'text-muted-foreground',
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
          'flex min-w-0 items-center gap-1 text-left',
          variant === 'field'
            ? 'focus-ring border-input h-8 w-full rounded-md border px-2.5 shadow-xs'
            : 'focus-ring-inset h-full w-full rounded px-1',
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-ui">
          {selected ? (
            <>
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-micro font-semibold text-background">
                {refName(refNames, selected).charAt(0).toUpperCase()}
              </span>
              <span className="truncate">{refName(refNames, selected)}</span>
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
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
            className="text-muted-foreground"
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
  const opts = def.options?.options ?? []
  const selected: Array<string> = multi
    ? Array.isArray(value)
      ? (value as Array<string>)
      : []
    : value == null
      ? []
      : [String(value)]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={def.name}
        className={cn(
          'flex min-w-0 items-center gap-1 text-left',
          variant === 'field'
            ? 'focus-ring border-input h-8 w-full rounded-md border px-2.5 shadow-xs'
            : 'focus-ring-inset h-full w-full rounded px-1',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {selected.length === 0 ? (
            <span className="text-ui text-muted-foreground">—</span>
          ) : (
            selected.map((id) => {
              const idx = opts.findIndex((o) => o.id === id)
              const opt = idx >= 0 ? opts[idx] : undefined
              return (
                <span
                  key={id}
                  style={badgeStyle(optionColor(opt, Math.max(idx, 0)))}
                  className="truncate rounded-full px-2 py-0.5 text-label font-medium"
                >
                  {opt?.label ?? String(id)}
                </span>
              )
            })
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {multi
          ? opts.map((o, i) => (
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
                <span
                  style={badgeStyle(optionColor(o, i))}
                  className="rounded-full px-2 py-0.5 text-label font-medium"
                >
                  {o.label}
                </span>
              </DropdownMenuCheckboxItem>
            ))
          : [
              ...opts.map((o, i) => (
                <DropdownMenuItem key={o.id} onSelect={() => onSave(o.id)}>
                  <span
                    style={badgeStyle(optionColor(o, i))}
                    className="rounded-full px-2 py-0.5 text-label font-medium"
                  >
                    {o.label}
                  </span>
                </DropdownMenuItem>
              )),
              selected.length > 0 ? (
                <DropdownMenuItem
                  key="__clear"
                  onSelect={() => onSave(null)}
                  className="text-muted-foreground"
                >
                  Clear
                </DropdownMenuItem>
              ) : null,
            ]}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
