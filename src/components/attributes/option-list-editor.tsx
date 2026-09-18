import { useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import {
  BADGE_COLORS,
  badgeStyle,
  nextBadgeColor,
} from '#/lib/attributes/colors'
import type { BadgeColor } from '#/lib/attributes/colors'
import { cn } from '#/lib/utils'

/**
 * The inline options editor (spec §7; Overlays · Flows "New attribute"):
 * a rule-bordered box of 30px rows — ⋮⋮ grip, a 14px square swatch, the
 * label, the status group — with a composer as the last row. Enter appends,
 * Backspace on an empty unsaved row drops it, Alt+↑↓ reorder, a pasted
 * list becomes rows. Saved options archive rather than delete (§3): they
 * stay struck in graphite with a mono `restore`; only never-saved rows can
 * be removed. Hue is auto-assigned; the swatch overrides it.
 */

export type OptionGroup = 'active' | 'parked' | 'closed'

export const OPTION_GROUPS: Array<OptionGroup> = ['active', 'parked', 'closed']

/** A `<select>`'s string back to a status group, or null if it names none. */
export function toOptionGroup(v: string): OptionGroup | null {
  return OPTION_GROUPS.find((g) => g === v) ?? null
}

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

/** A pasted list: one option per line, or comma-separated on one line. */
function splitPasted(text: string): Array<string> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const parts = lines.length > 1 ? lines : text.split(',')
  return parts.map((p) => p.trim()).filter(Boolean)
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

  const insertAfter = (i: number, labels: Array<string> = ['']) => {
    const rows = labels.map((label, k) => ({
      ...newDraft(drafts.length + k, isStatus ? 'active' : undefined),
      label,
    }))
    const next = [...drafts]
    next.splice(i + 1, 0, ...rows)
    onChange(next)
    const last = rows.at(-1)
    if (last) focus(last.key)
  }

  /** A pasted list lands in one change: this row takes the first line,
   *  the rest become rows after it. */
  const pasteInto = (i: number, parts: Array<string>) => {
    const [first = '', ...rest] = parts
    const rows = rest.map((label, k) => ({
      ...newDraft(drafts.length + k, isStatus ? 'active' : undefined),
      label,
    }))
    const next = drafts.map((d, j) =>
      j === i ? { ...d, label: (d.label + first).trim() } : d,
    )
    next.splice(i + 1, 0, ...rows)
    onChange(next)
    const last = rows.at(-1)
    if (last) focus(last.key)
  }

  const removeAt = (i: number) => {
    const next = drafts.filter((_, j) => j !== i)
    onChange(next)
    const prev = next.at(Math.max(0, i - 1))
    if (prev) focus(prev.key)
  }

  const saved = drafts.some((d) => d.id)

  return (
    <div className="flex flex-col gap-1.5">
      <ul
        className="flex flex-col border border-rule"
        role="list"
        aria-label="Options"
      >
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
              'flex h-[1.875rem] items-center gap-2 border-b border-rule px-2 transition-[background-color,opacity] duration-150 ease-out-quart',
              dragging === i && 'opacity-50',
              over === i && dragging !== i && 'bg-bone',
            )}
          >
            <span
              aria-hidden
              className="shrink-0 cursor-grab touch-none mono text-micro text-rule active:cursor-grabbing"
            >
              ⋮⋮
            </span>
            <ColorPicker
              value={o.color}
              label={o.label || `Option ${i + 1}`}
              onPick={(color) => update(i, { color })}
            />
            <input
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
              onPaste={(e) => {
                const parts = splitPasted(e.clipboardData.getData('text'))
                if (parts.length < 2) return
                e.preventDefault()
                pasteInto(i, parts)
              }}
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
              className={cn(
                'focus-ring-inset h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-graphite',
                o.archived && 'text-graphite line-through',
              )}
            />
            {isStatus ? (
              <select
                value={o.group ?? 'active'}
                aria-label={`Group for ${o.label || `option ${i + 1}`}`}
                onChange={(e) => {
                  const group = toOptionGroup(e.target.value)
                  if (group) update(i, { group })
                }}
                className="focus-ring h-6 shrink-0 border border-rule bg-transparent px-1.5 mono text-micro text-graphite"
              >
                <option value="active">active</option>
                <option value="parked">parked</option>
                <option value="closed">closed</option>
              </select>
            ) : null}
            {o.archived ? (
              <span className="shrink-0 mono text-[0.625rem] leading-3 text-graphite">
                archived
              </span>
            ) : null}
            {o.id ? (
              <button
                type="button"
                onClick={() => update(i, { archived: !o.archived })}
                className="focus-ring shrink-0 mono text-micro text-graphite transition-colors hover:text-foreground"
              >
                {o.archived ? 'restore' : 'archive'}
              </button>
            ) : (
              <button
                type="button"
                aria-label="Remove option"
                onClick={() => removeAt(i)}
                className="focus-ring flex size-5 shrink-0 items-center justify-center mono text-label text-graphite transition-colors hover:text-foreground"
              >
                ×
              </button>
            )}
          </li>
        ))}
        {/* The composer row: adding is typing, not clicking. */}
        <li>
          <button
            type="button"
            onClick={() => insertAfter(drafts.length - 1)}
            className="focus-ring-inset flex h-[1.875rem] w-full items-center gap-2 px-2 text-left transition-colors hover:bg-bone"
          >
            <span className="mono text-micro text-primary">+</span>
            <span className="text-ui text-graphite">
              Add option… or paste a list
            </span>
          </button>
        </li>
      </ul>
      <p className="mono text-[0.625rem] leading-3 text-graphite">
        ↵ adds the next · drag ⋮⋮ or ⌥↑↓ to reorder · hue auto-assigned, click
        the swatch to override
        {saved ? ' · saved options archive, never delete' : ''}
      </p>
    </div>
  )
}

/** A 24px mark button for editor rows: graphite until hover, bone behind. */
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
      className="focus-ring flex size-6 shrink-0 touch-manipulation items-center justify-center rounded-md text-graphite transition-colors duration-150 ease-out-quart hover:bg-bone hover:text-foreground disabled:pointer-events-none disabled:text-rule"
    >
      {children}
    </button>
  )
}

/**
 * Swatch picker for one option's badge colour: a fixed grid of the shipped
 * palette as 16px squares rather than a colour input — every swatch already
 * clears AA against its own ink, which an arbitrary hex cannot promise.
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
        className="focus-ring size-3.5 shrink-0 transition-[outline-color] duration-150 ease-out-quart hover:outline hover:outline-1 hover:outline-hairline"
        style={{ backgroundColor: `var(--badge-${value})` }}
      />
      <DropdownMenuContent align="start" className="w-auto p-2">
        {/* Menu items rather than plain buttons: a raw <button> inside Radix
            content leaves the popover open after a pick, so choosing a colour
            silently traps the next click. Items also get roving arrow-key
            focus, which a grid of buttons would not. */}
        <div className="grid grid-cols-6 gap-1">
          {BADGE_COLORS.map((c) => (
            <DropdownMenuItem
              key={c}
              aria-label={c}
              title={c}
              onSelect={() => onPick(c)}
              style={badgeStyle(c)}
              className={cn(
                'focus-ring size-5 rounded-none p-0 transition-[outline-color] duration-150 ease-out-quart',
                c === value && 'outline outline-1 outline-hairline',
              )}
            />
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
