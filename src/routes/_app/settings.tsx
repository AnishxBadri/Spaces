import { createFileRoute, useRouter } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Building2,
  Check,
  Kanban,
  Pencil,
  Plus,
  Users,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
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
  optionColor,
} from '#/lib/attributes/colors'
import type { BadgeColor } from '#/lib/attributes/colors'
import { listRegistry, updateAttribute } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * Object settings — the attribute registries behind Companies, People,
 * Deals. Structure fixed, content free: rename anything, edit options,
 * archive; types and system-ness are immutable.
 */
export const Route = createFileRoute('/_app/settings')({
  loader: async () => {
    const [company, person, deal] = await Promise.all([
      listRegistry({ data: { kind: 'company', includeArchived: true } }),
      listRegistry({ data: { kind: 'person', includeArchived: true } }),
      listRegistry({ data: { kind: 'deal', includeArchived: true } }),
    ])
    return { company, person, deal }
  },
  component: SettingsPage,
})

type Registry = Awaited<ReturnType<typeof listRegistry>>
type Attr = Registry[number]
type Kind = 'company' | 'person' | 'deal'

const OBJECTS: Array<{ kind: Kind; label: string; icon: typeof Building2 }> = [
  { kind: 'company', label: 'Companies', icon: Building2 },
  { kind: 'person', label: 'People', icon: Users },
  { kind: 'deal', label: 'Deals', icon: Kanban },
]

const TYPE_LABELS: Record<string, string> = {
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

function SettingsPage() {
  const registries = Route.useLoaderData()
  const router = useRouter()
  const [kind, setKind] = useState<Kind>('company')
  const registry = registries[kind]

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 md:px-10">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Objects and their attributes. Rename anything, edit options, archive
          what you don't use — types are fixed.
        </p>
      </header>

      <div className="mt-6 flex items-center justify-between border-b border-border">
        <div role="tablist" className="flex gap-1">
          {OBJECTS.map((o) => (
            <button
              key={o.kind}
              role="tab"
              aria-selected={kind === o.kind}
              onClick={() => setKind(o.kind)}
              className={cn(
                'relative flex items-center gap-1.5 px-3 pb-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-t-md',
                kind === o.kind &&
                  'text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary',
              )}
            >
              <o.icon className="size-3.5" strokeWidth={1.75} />
              {o.label}
              <span className="tabular text-xs text-muted-foreground">
                {registries[o.kind].filter((a) => !a.archived).length}
              </span>
            </button>
          ))}
        </div>
        <AttributeCreateDialog
          objectKind={kind}
          onCreated={() => router.invalidate()}
          trigger={
            <Button size="xs" variant="outline">
              <Plus className="size-3" strokeWidth={2} />
              New attribute
            </Button>
          }
        />
      </div>

      <ul className="mt-4 divide-y divide-border/60 rounded-lg border border-border">
        {registry.map((attr, idx) => (
          <AttributeRow
            key={attr.id}
            attr={attr}
            isFirst={idx === 0}
            isLast={idx === registry.length - 1}
          />
        ))}
      </ul>
    </div>
  )
}

function AttributeRow({
  attr,
  isFirst,
  isLast,
}: {
  attr: Attr
  isFirst: boolean
  isLast: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)

  async function act(
    patch: Parameters<typeof updateAttribute>[0]['data'] extends infer D
      ? Omit<D, 'id'>
      : never,
    message?: string,
  ) {
    try {
      await updateAttribute({ data: { id: attr.id, ...patch } })
      if (message) toast(message)
      router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update')
    }
  }

  const options =
    ((attr.options as Record<string, unknown> | null)?.options as Array<{
      id: string
      label: string
      group?: string
      color?: string
    }>) ?? []
  const hasOptions = ['select', 'multi_select', 'status'].includes(attr.type)

  return (
    <li
      className={cn(
        'flex flex-col gap-2 px-4 py-3',
        attr.archived && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <InlineName name={attr.name} onSave={(name) => act({ name })} />
          <span className="text-xs text-muted-foreground">
            {TYPE_LABELS[attr.type] ?? attr.type}
            {attr.type === 'record_reference'
              ? ` → ${(attr.options as Record<string, unknown> | null)?.targetKind ?? ''}`
              : ''}
          </span>
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
          <IconBtn
            label="Move up"
            disabled={isFirst}
            onClick={() => act({ move: 'up' })}
          >
            <ArrowUp className="size-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn
            label="Move down"
            disabled={isLast}
            onClick={() => act({ move: 'down' })}
          >
            <ArrowDown className="size-3.5" strokeWidth={1.75} />
          </IconBtn>
          {hasOptions ? (
            <IconBtn
              label={editing ? 'Close options' : 'Edit options'}
              onClick={() => setEditing((v) => !v)}
            >
              <Pencil className="size-3.5" strokeWidth={1.75} />
            </IconBtn>
          ) : null}
          <IconBtn
            label={attr.archived ? 'Restore' : 'Archive'}
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

      {hasOptions && !editing && options.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {options.map((o, i) => (
            <span
              key={o.id}
              style={badgeStyle(optionColor(o, i))}
              className="rounded-full px-2 py-0.5 text-label font-medium"
            >
              {o.label}
            </span>
          ))}
        </div>
      ) : null}

      {hasOptions && editing ? (
        <OptionsEditor
          attr={attr}
          options={options}
          onDone={(next) => {
            setEditing(false)
            if (next) act({ options: next }, 'Options saved')
          }}
        />
      ) : null}
    </li>
  )
}

function InlineName({
  name,
  onSave,
}: {
  name: string
  onSave: (name: string) => void
}) {
  const [draft, setDraft] = useState(name)
  return (
    <input
      value={draft}
      aria-label="Attribute name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() && draft !== name && onSave(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(name)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className="block w-full truncate bg-transparent text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
    />
  )
}

function OptionsEditor({
  attr,
  options,
  onDone,
}: {
  attr: Attr
  options: Array<{
    id: string
    label: string
    group?: string
    color?: string
  }>
  onDone: (
    next: Array<{
      id?: string
      label: string
      group?: 'active' | 'parked' | 'closed'
      color?: BadgeColor
    }> | null,
  ) => void
}) {
  const [drafts, setDrafts] = useState(
    options.map((o, i) => ({
      ...o,
      color: optionColor(o, i),
    })) as Array<{
      id?: string
      label: string
      group?: 'active' | 'parked' | 'closed'
      color: BadgeColor
    }>,
  )
  const isStatus = attr.type === 'status'

  return (
    <div className="rounded-md border border-border p-3">
      <div className="space-y-1.5">
        {drafts.map((o, i) => (
          <div key={o.id ?? `new-${i}`} className="flex items-center gap-2">
            <Input
              value={o.label}
              aria-label={`Option ${i + 1}`}
              onChange={(e) =>
                setDrafts((ds) =>
                  ds.map((d, j) =>
                    j === i ? { ...d, label: e.target.value } : d,
                  ),
                )
              }
              className="h-7 max-w-56 text-xs"
            />
            {isStatus ? (
              <select
                value={o.group ?? 'active'}
                aria-label="Group"
                onChange={(e) =>
                  setDrafts((ds) =>
                    ds.map((d, j) =>
                      j === i ? { ...d, group: e.target.value as 'active' } : d,
                    ),
                  )
                }
                className="border-input h-7 rounded-md border bg-transparent px-2 text-xs outline-none"
              >
                <option value="active">Active</option>
                <option value="parked">Parked</option>
                <option value="closed">Closed</option>
              </select>
            ) : null}
            <ColorPicker
              value={o.color}
              label={o.label || `Option ${i + 1}`}
              onPick={(color) =>
                setDrafts((ds) =>
                  ds.map((d, j) => (j === i ? { ...d, color } : d)),
                )
              }
            />
            {!o.id ? (
              <IconBtn
                label="Remove new option"
                onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}
              >
                <X className="size-3" strokeWidth={2} />
              </IconBtn>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            setDrafts((ds) => [
              ...ds,
              {
                label: '',
                color: nextBadgeColor(
                  ds.length,
                  isStatus ? 'active' : undefined,
                ),
                ...(isStatus ? { group: 'active' as const } : {}),
              },
            ])
          }
        >
          <Plus className="size-3" strokeWidth={2} />
          Add option
        </Button>
        <span className="text-xs text-muted-foreground">
          Existing options can be renamed, not removed.
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button
            size="xs"
            onClick={() => onDone(drafts.filter((d) => d.label.trim()))}
          >
            <Check className="size-3" strokeWidth={2} />
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function IconBtn({
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
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6.5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
function ColorPicker({
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
        aria-label={`Colour for ${label}`}
        title={`Colour: ${value}`}
        className="focus-ring size-6 shrink-0 rounded-full border border-border transition-colors duration-150 ease-out-quart hover:border-input"
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
                'focus-ring flex size-7 items-center justify-center rounded-full border p-0 transition-colors duration-150 ease-out-quart',
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
