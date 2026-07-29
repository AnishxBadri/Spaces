import { Check, ChevronDown, Star } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
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
    options?: Array<{ id: string; label: string; group?: string; color?: string }>
    max?: number
    code?: string
  } | null
  isSystem: boolean
}

type Props = {
  def: RegistryEntry
  value: unknown
  onSave: (value: unknown) => void
  variant: 'cell' | 'field'
  autoFocus?: boolean
}

const STATUS_GROUP_COLORS: Record<string, string> = {
  active: 'bg-selected text-foreground',
  parked: 'bg-info/10 text-info',
  closed: 'bg-muted text-muted-foreground',
}

export function optionLabel(def: RegistryEntry, id: unknown): string {
  const opt = def.options?.options?.find((o) => o.id === id)
  return opt?.label ?? String(id ?? '')
}

export function ValueEditor({ def, value, onSave, variant, autoFocus }: Props) {
  switch (def.type) {
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
            'flex size-4 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
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
        <div className="flex items-center gap-0.5" role="radiogroup" aria-label={def.name}>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={current === n}
              aria-label={`${n} of ${max}`}
              onClick={() => onSave(current === n ? null : n)}
              className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
      placeholder={variant === 'field' ? '—' : ''}
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
        'w-full min-w-0 bg-transparent text-[13px] outline-none',
        (def.type === 'number' || def.type === 'currency') && 'tabular text-right',
        variant === 'field'
          ? 'border-input h-8 rounded-md border px-2.5 shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
          : 'h-full rounded px-1 focus-visible:ring-2 focus-visible:ring-ring/60',
      )}
    />
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
          'flex min-w-0 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          variant === 'field'
            ? 'border-input h-8 w-full rounded-md border px-2.5 shadow-xs'
            : 'h-full w-full rounded px-1',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {selected.length === 0 ? (
            <span className="text-[13px] text-muted-foreground/60">—</span>
          ) : (
            selected.map((id) => {
              const opt = opts.find((o) => o.id === id)
              const groupClass = opt?.group
                ? STATUS_GROUP_COLORS[opt.group]
                : 'bg-muted text-foreground'
              return (
                <span
                  key={id}
                  className={cn(
                    'truncate rounded-full px-2 py-0.5 text-xs font-medium',
                    def.type === 'status' || multi || def.type === 'select'
                      ? groupClass
                      : '',
                  )}
                >
                  {opt?.label ?? String(id)}
                </span>
              )
            })
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {multi
          ? opts.map((o) => (
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
                {o.label}
              </DropdownMenuCheckboxItem>
            ))
          : [
              ...opts.map((o) => (
                <DropdownMenuItem key={o.id} onSelect={() => onSave(o.id)}>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      o.group
                        ? STATUS_GROUP_COLORS[o.group]
                        : 'bg-muted',
                    )}
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
