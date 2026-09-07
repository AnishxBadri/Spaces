import {
  Archive,
  ArchiveRestore,
  Check,
  GripVertical,
  Plus,
  X,
} from 'lucide-react'
import { useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import {
  BADGE_COLORS,
  badgeStyle,
  nextBadgeColor,
} from '#/lib/attributes/colors'
import type { BadgeColor } from '#/lib/attributes/colors'
import { cn } from '#/lib/utils'

/**
 * The inline options editor (spec §7): colour dot + label rows, drag to
 * reorder, Enter appends — the composer-bar pattern, so building a list is
 * typing, not clicking. Existing options archive rather than delete (§3);
 * only rows that never saved can be removed.
 */

export type OptionGroup = 'active' | 'parked' | 'closed'

export type OptionDraft = {
  /** stable client key — new rows have no id yet */
  key: string
  id?: string
  label: string
  group?: OptionGroup
  color: BadgeColor
  archived?: boolean
}

let seq = 0
export const newDraft = (index: number, group?: OptionGroup): OptionDraft => ({
  key: `new-${++seq}`,
  label: '',
  ...(group ? { group } : {}),
  color: nextBadgeColor(index, group),
})

function move<T>(list: Array<T>, from: number, to: number): Array<T> {
  if (to < 0 || to >= list.length || from === to) return list
  const next = [...list]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row)
  return next
}

export function OptionListEditor({
  type,
  drafts,
  onChange,
}: {
  type: 'select' | 'multi_select' | 'status'
  drafts: Array<OptionDraft>
  onChange: (next: Array<OptionDraft>) => void
}) {
  const isStatus = type === 'status'
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  const focus = (key: string) =>
    requestAnimationFrame(() => inputs.current.get(key)?.focus())

  const update = (i: number, patch: Partial<OptionDraft>) =>
    onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)))

  const insertAfter = (i: number) => {
    const row = newDraft(drafts.length, isStatus ? 'active' : undefined)
    const next = [...drafts]
    next.splice(i + 1, 0, row)
    onChange(next)
    focus(row.key)
  }

  const removeAt = (i: number) => {
    const next = drafts.filter((_, j) => j !== i)
    onChange(next)
    const prev = next.at(Math.max(0, i - 1))
    if (prev) focus(prev.key)
  }

  return (
    <div className="space-y-1.5">
      <ul className="space-y-1" role="list" aria-label="Options">
        {drafts.map((o, i) => (
          <li
            key={o.key}
            draggable
            onDragStart={(e) => {
              setDragging(i)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/option-index', String(i))
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (over !== i) setOver(i)
            }}
            onDragLeave={() => setOver((v) => (v === i ? null : v))}
            onDrop={(e) => {
              e.preventDefault()
              const from = Number(e.dataTransfer.getData('text/option-index'))
              setDragging(null)
              setOver(null)
              if (Number.isInteger(from)) onChange(move(drafts, from, i))
            }}
            onDragEnd={() => {
              setDragging(null)
              setOver(null)
            }}
            className={cn(
              'flex items-center gap-1.5 rounded-md transition-[background-color,opacity] duration-150 ease-out-quart',
              dragging === i && 'opacity-50',
              over === i && dragging !== i && 'bg-accent',
              o.archived && 'text-muted-foreground opacity-60',
            )}
          >
            <span
              aria-hidden
              className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing"
            >
              <GripVertical className="size-3.5" strokeWidth={1.75} />
            </span>
            <ColorPicker
              value={o.color}
              label={o.label || `Option ${i + 1}`}
              onPick={(color) => update(i, { color })}
            />
            <Input
              ref={(el) => {
                if (el) inputs.current.set(o.key, el)
                else inputs.current.delete(o.key)
              }}
              value={o.label}
              aria-label={`Option ${i + 1}`}
              placeholder={i === 0 ? 'First option' : 'Another option'}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => update(i, { label: e.target.value })}
              onKeyDown={(e) => {
                // Enter appends (never submits from inside the list);
                // Backspace on an empty unsaved row drops it; Alt+arrows
                // reorder without a mouse — parity with the drag handle.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  insertAfter(i)
                } else if (e.key === 'Backspace' && !o.label && !o.id) {
                  e.preventDefault()
                  removeAt(i)
                } else if (e.altKey && e.key === 'ArrowUp') {
                  e.preventDefault()
                  onChange(move(drafts, i, i - 1))
                } else if (e.altKey && e.key === 'ArrowDown') {
                  e.preventDefault()
                  onChange(move(drafts, i, i + 1))
                }
              }}
              className="h-8 flex-1 text-ui"
            />
            {isStatus ? (
              <select
                value={o.group ?? 'active'}
                aria-label={`Group for ${o.label || `option ${i + 1}`}`}
                onChange={(e) =>
                  update(i, { group: e.target.value as OptionGroup })
                }
                className="h-8 rounded-md border border-input bg-transparent px-2 text-ui shadow-xs focus-ring"
              >
                <option value="active">Active</option>
                <option value="parked">Parked</option>
                <option value="closed">Closed</option>
              </select>
            ) : null}
            {o.id ? (
              <IconBtn
                label={
                  o.archived
                    ? `Restore ${o.label || 'option'}`
                    : `Archive ${o.label || 'option'}`
                }
                onClick={() => update(i, { archived: !o.archived })}
              >
                {o.archived ? (
                  <ArchiveRestore className="size-3.5" strokeWidth={1.75} />
                ) : (
                  <Archive className="size-3.5" strokeWidth={1.75} />
                )}
              </IconBtn>
            ) : (
              <IconBtn label="Remove option" onClick={() => removeAt(i)}>
                <X className="size-3.5" strokeWidth={2} />
              </IconBtn>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 pl-7.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => insertAfter(drafts.length - 1)}
        >
          <Plus className="size-3" strokeWidth={2} />
          Add option
        </Button>
        <span className="text-label text-muted-foreground">
          Enter adds the next one · drag or Alt+↑↓ to reorder
          {drafts.some((d) => d.id)
            ? ' · saved options archive, never delete'
            : ''}
        </span>
      </div>
    </div>
  )
}

export function IconBtn({
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
      className="flex size-6.5 shrink-0 touch-manipulation items-center justify-center rounded text-muted-foreground focus-ring transition-colors duration-150 ease-out-quart hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/**
 * Swatch picker for one option's badge colour. A fixed grid of the shipped
 * palette rather than a colour input: every swatch is already known to clear
 * AA against its own ink, which an arbitrary hex cannot promise.
 */
export function ColorPicker({
  value,
  label,
  onPick,
}: {
  value: BadgeColor
  label: string
  onPick: (color: BadgeColor) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        aria-label={`Colour for ${label}`}
        title={`Colour: ${value}`}
        className="size-6 shrink-0 rounded-full border border-border focus-ring transition-colors duration-150 ease-out-quart hover:border-input"
        style={{ backgroundColor: `var(--badge-${value})` }}
      >
        <span
          className="mx-auto block size-2.5 rounded-full"
          style={{ backgroundColor: `var(--badge-${value}-ink)` }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto p-2">
        {/* Menu items rather than plain buttons: a raw <button> inside Radix
            content leaves the popover open after a pick, so choosing a colour
            silently traps the next click. Items also get roving arrow-key
            focus, which a grid of buttons would not. */}
        <div className="grid grid-cols-6 gap-1.5">
          {BADGE_COLORS.map((c) => (
            <DropdownMenuItem
              key={c}
              aria-label={c}
              title={c}
              onSelect={() => onPick(c)}
              style={badgeStyle(c)}
              className={cn(
                'flex size-7 items-center justify-center rounded-full border p-0 focus-ring transition-colors duration-150 ease-out-quart',
                c === value ? 'border-foreground' : 'border-transparent',
              )}
            >
              {c === value ? (
                <Check className="size-3" strokeWidth={3} />
              ) : null}
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
