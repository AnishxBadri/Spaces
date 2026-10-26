import { ChevronDown, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '#/components/ui/popover'
import { useCallingCodes } from './calling-codes'
import { DitherMark, InitialsMark } from '#/components/record/record-parts'
import { Badge } from '#/components/ui/badge'
import { Checkbox } from '#/components/ui/checkbox'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { liveOptions, optionState } from '@spaces/core/attributes/options'
import { isNonIdentityValue } from '@spaces/core/attributes/registry'
import {
  phoneProblem,
  formatPhone,
  toE164,
} from '@spaces/core/attributes/phone'
import { formatDay, formatNumber } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { fmtMoney } from '@spaces/core/portfolio/format'
import { listUsers, searchEntities } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import type { AttributeOptions } from '@spaces/core/attributes/registry'

/**
 * Typed attribute editors — ONE implementation shared by table cells,
 * record rails, and create modals. `variant` only changes chrome:
 * - 'cell': inset in a table cell, no rule.
 * - 'field': a record's property row — reads as a value, the rule on hover.
 * - 'form': inside a form beside `Input`s — the rule at rest, flush left.
 */

type Variant = 'cell' | 'field' | 'form'

/** The picker/input box for the two non-cell variants. */
const boxChrome = (variant: Variant) =>
  variant === 'form'
    ? 'focus-ring h-8 rounded-md border border-rule bg-paper px-2.5 transition-colors'
    : 'focus-ring h-8 rounded-md border border-transparent px-2 transition-colors hover:border-rule'

/**
 * A picker trigger off the table: the box, but growing past 32px when its
 * chips wrap — a property row or a form shows every value, where a table
 * cell clips to its one line.
 */
const pickerChrome = (variant: Variant) =>
  cn(
    boxChrome(variant),
    'h-auto min-h-8 w-full py-1 data-[state=open]:border-rule',
  )

export type RegistryEntry = {
  id?: string
  slug: string
  name: string
  type: string
  options: AttributeOptions | null
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
  variant: Variant
  /** display names for record/actor reference ids */
  refNames?: RefNames | undefined
}

/**
 * Create-dialog layout is type-driven, never hand-placed — the registry
 * generates the form, so the span rule must survive any custom attribute.
 * Half-width is the default; only genuinely long-form fields span both
 * columns. Description is the one long-form field, by convention.
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
 * deliberate deviation from Attio.
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
    // The one badge that sizes to its text instead of to the 20px lane: it
    // renders inside table cells and property rows that set their own height,
    // so `h-auto py-0.5` keeps the chip intrinsic and `inline-flex` keeps it
    // inline-level where the parent is not a flex row.
    <Badge
      option={state.option}
      index={state.index}
      archived={state.archived}
      title={state.archived ? 'Archived option' : undefined}
      className={cn('inline-flex h-auto truncate py-0.5', className)}
    >
      {state.label}
    </Badge>
  )
}

export function ValueEditor({ def, value, onSave, variant, refNames }: Props) {
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
      // A form sets the stage a record is born at — no move, so no reason.
      if (variant === 'form')
        return (
          <OptionPicker
            def={def}
            value={value}
            onSave={onSave}
            variant={variant}
            multi={false}
          />
        )
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
    case 'email':
    case 'domain':
    case 'phone':
      // A person's emails, a company's domains, a list of phones.
      if (def.options?.multi)
        return (
          <MultiTextPicker
            def={def}
            value={value}
            onSave={onSave}
            variant={variant}
          />
        )
      return (
        <TextLikeEditor
          def={def}
          value={value}
          onSave={onSave}
          variant={variant}
        />
      )
    case 'checkbox':
      return (
        <Checkbox
          checked={Boolean(value)}
          onCheckedChange={(next) => onSave(next)}
          aria-label={def.name}
          className={cn(variant === 'field' && 'ml-2')}
        />
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
            variant === 'form' && 'h-8',
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
      return variant !== 'form' ? (
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
        />
      )
    default:
      return (
        <TextLikeEditor
          def={def}
          value={value}
          onSave={onSave}
          variant={variant}
        />
      )
  }
}

/**
 * A date in a table cell or a property row reads as the day until clicked,
 * then hands over to the native control with its picker open.
 * - `<input type="date">` at rest prints a `mm/dd/yyyy` skeleton and a picker
 *   glyph in every empty row, where every other empty value is an em dash.
 * - In a form the native control is right as it is.
 */
function DateCellEditor({ def, value, onSave, variant }: Props) {
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const stored = value == null ? '' : String(value)
  const { today } = useClock()

  useEffect(() => {
    if (!editing) return
    // The click that opened the editor is the activation `showPicker` needs.
    try {
      input.current?.showPicker()
    } catch {
      // No picker to show (an older engine, or no activation): typing works.
    }
  }, [editing])

  if (editing) {
    return (
      <input
        ref={input}
        type="date"
        defaultValue={stored}
        autoFocus
        aria-label={def.name}
        onBlur={(e) => {
          setEditing(false)
          if (e.target.value !== stored) onSave(e.target.value || null)
        }}
        onKeyDown={(e) => {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- React types a key event's target as EventTarget; the handler is on the input itself
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditing(false)
        }}
        className={cn(
          'w-full min-w-0 bg-transparent text-ui',
          variant === 'cell'
            ? 'focus-ring-inset h-full rounded-md px-1'
            : cn(boxChrome(variant), 'focus:border-rule'),
        )}
      />
    )
  }

  return (
    <button
      type="button"
      aria-label={def.name}
      onClick={() => setEditing(true)}
      className={cn(
        'w-full text-left text-ui',
        variant === 'cell'
          ? 'focus-ring-inset h-full rounded-md px-1'
          : boxChrome(variant),
        variant === 'cell' ? 'numeric' : 'tabular',
        !stored && 'text-graphite',
      )}
    >
      {stored ? formatDay(stored.slice(0, 10), today) || stored : '—'}
    </button>
  )
}

function TextLikeEditor({ def, value, onSave, variant }: Props) {
  const display = value == null ? '' : String(value)
  const [draft, setDraft] = useState(display)
  const [focused, setFocused] = useState(false)
  const committed = useRef(display)
  useEffect(() => {
    setDraft(display)
    committed.current = display
  }, [display])
  // A number with a precision setting reads formatted (grouping, fixed
  // decimals) until it's being edited, and so does money — `$150,000` in the
  // attribute's own currency, not `150000`. The stored number is untouched;
  // focus hands back the raw figure to edit.
  const precision = def.type === 'number' ? def.options?.precision : undefined
  const currency =
    def.type === 'currency' ? (def.options?.code ?? 'USD') : undefined
  // A phone is stored in E.164 and reads grouped until it is edited.
  const phone = def.type === 'phone'
  const formatted =
    (precision !== undefined || currency !== undefined || phone) && !focused
  const atRest = (raw: string): string => {
    if (phone) return formatPhone(raw)
    if (currency === undefined) return formatNumber(raw, precision)
    const n = Number(raw)
    return raw.trim() === '' || !Number.isFinite(n)
      ? raw
      : fmtMoney(n, currency)
  }

  function commit() {
    if (draft === committed.current) return
    committed.current = draft
    if (draft.trim() === '') return onSave(null)
    if (def.type === 'number' || def.type === 'currency') {
      const n = Number(draft)
      return onSave(Number.isFinite(n) ? n : null)
    }
    // Formatted on blur; a non-number goes to the write path, which names the shape.
    if (phone) {
      const e164 = toE164(draft)
      if (e164 !== null) {
        setDraft(e164)
        committed.current = e164
      }
      return onSave(e164 ?? draft.trim())
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
  // A phone offers the ITU codes on focus until one is in.
  const codes = useCallingCodes({
    draft,
    active: phone && focused,
    onPick: setDraft,
  })

  const field = (
    <input
      type={inputType}
      inputMode={def.type === 'number' ? 'decimal' : phone ? 'tel' : undefined}
      {...(phone ? codes.inputProps : {})}
      value={formatted ? atRest(draft) : draft}
      aria-label={def.name}
      placeholder="—"
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onKeyDown={(e) => {
        if (phone && codes.onKeyDown(e)) return
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- React types a key event's target as EventTarget; the handler is on the input itself
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(committed.current)
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- React types a key event's target as EventTarget; the handler is on the input itself
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className={cn(
        'w-full min-w-0 bg-transparent text-ui',
        // A column of figures right-aligns; a property row's value lane is
        // left-aligned like every other value.
        (def.type === 'number' || def.type === 'currency') &&
          (variant === 'cell' ? 'numeric' : 'tabular'),
        variant !== 'cell'
          ? // ↵ commits, esc reverts; the reticle on focus.
            cn(boxChrome(variant), 'focus:border-rule')
          : // Inset inside a cell: an offset ring would be clipped by the
            // table's scroll container and overlap the neighbouring column.
            'focus-ring-inset h-full rounded-md px-1',
      )}
    />
  )
  if (!phone) return field
  return (
    <Popover open={codes.open}>
      <PopoverAnchor asChild>{field}</PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {codes.list}
      </PopoverContent>
    </Popover>
  )
}

function RecordRefPicker({ def, value, onSave, variant, refNames }: Props) {
  const multi = Boolean(def.options?.multi)
  const targetKind = def.options?.targetKind ?? 'company'
  // A custom-object target: search that object's records, not a kind.
  const targetObjectId = def.options?.targetObjectId
  const selected: Array<string> = multi
    ? Array.isArray(value)
      ? value.map(String)
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
            : { q: query, kinds: [targetKind] },
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
          variant !== 'cell'
            ? pickerChrome(variant)
            : 'focus-ring-inset h-full w-full rounded-md px-1',
        )}
      >
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1',
            // A cell is one 36px line: its chips clip rather than wrap.
            variant === 'cell' ? 'overflow-hidden' : 'flex-wrap',
          )}
        >
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

/**
 * A multi-valued `email` / `domain` / `phone`: the values as chips, a box to
 * add one (↵), and each value a menu item that removes it. The write path
 * cleans, de-duplicates and — on an identity attribute — claims every
 * element. A phone is added in E.164 and shown grouped.
 */
function MultiTextPicker({ def, value, onSave, variant }: Props) {
  const selected: Array<string> = Array.isArray(value) ? value.map(String) : []
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const phone = def.type === 'phone'
  const shown = (v: string) => (phone ? formatPhone(v) : v)
  const codes = useCallingCodes({
    draft,
    active: phone && focused,
    onPick: setDraft,
  })
  // A cell shows a list's first phone, a property row a person's first
  // email; a mono +N counts the rest.
  const chips =
    (phone && variant === 'cell') ||
    (def.type === 'email' && variant === 'field')
      ? selected.slice(0, 1)
      : selected
  const more = selected.length - chips.length

  function add() {
    const raw = draft.trim()
    if (raw === '') return
    const next = phone ? toE164(raw) : raw
    if (next === null) {
      setProblem(phoneProblem(raw))
      return
    }
    setDraft('')
    setProblem(null)
    if (!selected.includes(next)) onSave([...selected, next])
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={def.name}
        className={cn(
          'group/pick flex min-w-0 items-center gap-1 text-left',
          variant !== 'cell'
            ? pickerChrome(variant)
            : 'focus-ring-inset h-full w-full rounded-md px-1',
        )}
      >
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1',
            // A cell is one 36px line: its chips clip rather than wrap.
            variant === 'cell' ? 'overflow-hidden' : 'flex-wrap',
          )}
        >
          {selected.length === 0 ? (
            <span className="text-ui text-graphite">—</span>
          ) : (
            chips.map((v) => (
              <span key={v} className="flex min-w-0 items-center gap-1">
                <span className="flex h-5 items-center truncate border border-rule bg-paper px-1.5 mono text-label">
                  {shown(v)}
                </span>
                {def.options?.identityKey !== undefined &&
                isNonIdentityValue(def.options.identityKey, v) ? (
                  <SharedInboxMark />
                ) : null}
              </span>
            ))
          )}
          {more > 0 ? (
            <span className="mono text-micro text-graphite">+{more}</span>
          ) : null}
        </span>
        <ChevronDown className="size-3 shrink-0 text-graphite opacity-0 transition-opacity group-hover/pick:opacity-100 group-focus-visible/pick:opacity-100 group-data-[state=open]/pick:opacity-100" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <div className="p-1.5">
          <Input
            value={draft}
            autoFocus
            type={def.type === 'email' ? 'email' : phone ? 'tel' : 'text'}
            aria-label={`Add to ${def.name}`}
            aria-invalid={problem !== null}
            placeholder={
              def.type === 'email'
                ? 'name@company.com ↵'
                : phone
                  ? '+14155550100 ↵'
                  : 'company.com ↵'
            }
            {...(phone ? codes.inputProps : {})}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              setDraft(e.target.value)
              setProblem(null)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (phone && codes.onKeyDown(e)) return
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            className="h-7 mono text-label"
          />
          {problem ? (
            <p role="alert" className="pt-1 text-label text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
        {phone && codes.open ? (
          <div className="border-b border-rule">{codes.list}</div>
        ) : null}
        {selected.map((v) => (
          <DropdownMenuItem
            key={v}
            aria-label={`Remove ${v}`}
            onSelect={() => {
              const next = selected.filter((s) => s !== v)
              onSave(next.length === 0 ? null : next)
            }}
          >
            <X className="size-3 text-graphite" strokeWidth={2} />
            <span className="truncate mono text-label">{shown(v)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The quiet mark beside a role address on a person's emails. */
function SharedInboxMark() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 mono text-micro text-graphite">
          shared inbox
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        A role address. Kept as contact data; never used to match or create a
        person.
      </TooltipContent>
    </Tooltip>
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
          variant !== 'cell'
            ? pickerChrome(variant)
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
      ? value.map(String)
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
          variant !== 'cell'
            ? pickerChrome(variant)
            : 'focus-ring-inset h-full w-full rounded-md px-1',
        )}
      >
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1',
            // A cell is one 36px line: its chips clip rather than wrap.
            variant === 'cell' ? 'overflow-hidden' : 'flex-wrap',
          )}
        >
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
