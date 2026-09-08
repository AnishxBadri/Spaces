import {
  AtSign,
  Calendar,
  Check,
  ChevronDown,
  Coins,
  Globe,
  Hash,
  Kanban,
  Link,
  Link2,
  List,
  ListChecks,
  Phone,
  Plus,
  SquareCheck,
  Star,
  Type,
  User,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '#/components/ui/command'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { optionColor } from '#/lib/attributes/colors'
import { deriveOptionIds } from '#/lib/attributes/options'
import { createAttribute, listObjects, updateAttribute } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { OptionListEditor, newDraft } from './option-list-editor'
import { ValueEditor } from './value-editor'
import type { OptionDraft, OptionGroup } from './option-list-editor'
import type { RegistryEntry } from './value-editor'
import type { ReactNode } from 'react'

/**
 * The one attribute dialog (spec §7). It morphs by type: a fixed header
 * (type first, then name, optional description), a per-type slot, then the
 * default widget and the required flag. No slug anywhere — derived and
 * hidden. In edit mode the type is static text and config edits ride the
 * §3 mutability guards server-side. Cmd/Ctrl+Enter submits from anywhere
 * in the form; Enter inside the options list appends a row instead.
 */

type ObjectKind = 'company' | 'person' | 'deal'

type TypeMeta = {
  id: string
  label: string
  hint: string
  icon: typeof Type
  keywords?: string
}

const TYPES: Array<TypeMeta> = [
  { id: 'text', label: 'Text', hint: 'A line of text', icon: Type },
  { id: 'number', label: 'Number', hint: 'Plain number', icon: Hash },
  { id: 'currency', label: 'Currency', hint: 'Money in one code', icon: Coins },
  { id: 'date', label: 'Date', hint: 'A calendar day', icon: Calendar },
  { id: 'checkbox', label: 'Checkbox', hint: 'Yes or no', icon: SquareCheck },
  { id: 'select', label: 'Select', hint: 'One of your options', icon: List },
  {
    id: 'multi_select',
    label: 'Multi-select',
    hint: 'Several of your options',
    icon: ListChecks,
    keywords: 'tags',
  },
  {
    id: 'status',
    label: 'Status',
    hint: 'Options in active, parked, closed groups',
    icon: Kanban,
    keywords: 'stage funnel',
  },
  { id: 'rating', label: 'Rating', hint: 'Stars, 1 to max', icon: Star },
  { id: 'url', label: 'URL', hint: 'A link', icon: Link },
  { id: 'email', label: 'Email', hint: 'An email address', icon: AtSign },
  { id: 'phone', label: 'Phone', hint: 'A phone number', icon: Phone },
  { id: 'domain', label: 'Domain', hint: 'A web domain', icon: Globe },
  {
    id: 'record_reference',
    label: 'Relationship',
    hint: 'Points at a company, person, or deal',
    icon: Link2,
    keywords: 'reference record link',
  },
  {
    id: 'actor_reference',
    label: 'User',
    hint: 'A teammate',
    icon: User,
    keywords: 'owner person member',
  },
]

/** System objects map to a core kind; customs are addressed by object id. */
const CORE_BY_SLUG: Partial<Record<string, ObjectKind>> = {
  companies: 'company',
  people: 'person',
  deals: 'deal',
}

const CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'INR',
  'SGD',
  'AED',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
]

const RELATIVE_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'PT0S', label: 'The day it is created' },
  { id: 'P7D', label: 'A week later' },
  { id: 'P14D', label: 'Two weeks later' },
  { id: 'P1M', label: 'A month later' },
  { id: 'P3M', label: 'A quarter later' },
]

const isDuration = (v: unknown): v is string =>
  typeof v === 'string' && /^P(?!$)/.test(v)

const TEXT_LIKE = new Set(['text', 'url', 'email', 'phone', 'domain'])
const NUMBER_LIKE = new Set(['number', 'currency'])
const OPTION_TYPES = new Set(['select', 'multi_select', 'status'])

/** What edit mode needs to know about the existing attribute. */
export type EditableAttribute = {
  id: string
  name: string
  description?: string | null
  type: string
  options: unknown
}

type ObjectChoice = {
  id: string
  slug: string
  singular: string
  isSystem: boolean
}

/** One value for the picker: a core kind, or `object:<id>` for a custom object. */
const targetValue = (o: ObjectChoice) =>
  (o.isSystem ? CORE_BY_SLUG[o.slug] : undefined) ?? `object:${o.id}`

type StoredOptions = {
  options?: Array<{
    id: string
    label: string
    group?: string
    color?: string
    archived?: boolean
  }>
  code?: string
  max?: number
  precision?: number
  targetKind?: ObjectKind
  targetObjectId?: string
  multi?: boolean
  required?: boolean
  default?: unknown
}

type Props = {
  /** a core kind, or an object row id — custom objects only have the latter */
  objectKind?: ObjectKind
  objectId?: string
  /** singular noun for copy ("every company"); defaults from objectKind */
  objectLabel?: string
  onSaved: () => void
  trigger?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
} & (
  | { mode: 'create'; attr?: undefined }
  | { mode: 'edit'; attr: EditableAttribute }
)

export function AttributeDialog(props: Props) {
  const { objectKind, objectId, objectLabel, onSaved, trigger, mode } = props
  const [selfOpen, setSelfOpen] = useState(false)
  const open = props.open ?? selfOpen
  const setOpen = props.onOpenChange ?? setSelfOpen

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {/* Remount per open so a cancelled draft never leaks into the next. */}
        {open ? (
          <AttributeForm
            key={mode === 'edit' ? props.attr.id : 'create'}
            objectKind={objectKind}
            objectId={objectId}
            objectLabel={objectLabel ?? objectKind ?? 'record'}
            mode={mode}
            attr={props.attr}
            onDone={(saved) => {
              setOpen(false)
              if (saved) onSaved()
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function AttributeForm({
  objectKind,
  objectId,
  objectLabel,
  mode,
  attr,
  onDone,
}: {
  objectKind?: ObjectKind
  objectId?: string
  objectLabel: string
  mode: 'create' | 'edit'
  attr?: EditableAttribute
  onDone: (saved: boolean) => void
}) {
  const stored = (attr?.options ?? {}) as StoredOptions
  const [type, setType] = useState<string>(attr?.type ?? 'text')
  const [name, setName] = useState(attr?.name ?? '')
  const [description, setDescription] = useState(attr?.description ?? '')
  const [drafts, setDrafts] = useState<Array<OptionDraft>>(() =>
    (stored.options ?? []).map((o, i) => ({
      key: o.id,
      id: o.id,
      label: o.label,
      ...(o.group ? { group: o.group as OptionGroup } : {}),
      color: optionColor(o, i),
      ...(o.archived ? { archived: true } : {}),
    })),
  )
  const [code, setCode] = useState(stored.code ?? 'USD')
  const [max, setMax] = useState(stored.max ?? 5)
  const [precision, setPrecision] = useState(stored.precision ?? 0)
  // The relationship target: a core kind or `object:<id>`.
  const [target, setTarget] = useState<string>(
    stored.targetKind ??
      (stored.targetObjectId ? `object:${stored.targetObjectId}` : ''),
  )
  const [objects, setObjects] = useState<Array<ObjectChoice>>([])
  useEffect(() => {
    if (type !== 'record_reference' || mode !== 'create') return
    let alive = true
    listObjects()
      .then((rows) => {
        if (alive)
          setObjects(
            rows.map((o) => ({
              id: o.id,
              slug: o.slug,
              singular: o.singular,
              isSystem: o.isSystem,
            })),
          )
      })
      .catch(() => setObjects([]))
    return () => {
      alive = false
    }
  }, [type, mode])
  const targetKind = (target && !target.startsWith('object:') ? target : '') as
    ObjectKind | ''
  const targetObjectId = target.startsWith('object:')
    ? target.slice('object:'.length)
    : ''
  const [multi, setMulti] = useState(stored.multi ?? false)
  const [required, setRequired] = useState(stored.required ?? false)
  const [dflt, setDflt] = useState<unknown>(stored.default ?? null)
  const [relative, setRelative] = useState(isDuration(stored.default))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [pendingCode, setPendingCode] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const meta = TYPES.find((t) => t.id === type) ?? TYPES[0]
  const isOptionType = OPTION_TYPES.has(type)

  // Type drives everything below the header; switching it in create mode
  // resets the slot and the default so nothing from the old shape lingers.
  function pickType(next: string) {
    if (next === type) return
    setType(next)
    setDrafts(
      OPTION_TYPES.has(next)
        ? [newDraft(0, next === 'status' ? 'active' : undefined)]
        : [],
    )
    setDflt(null)
    setRelative(false)
    setTarget('')
    setMulti(false)
    requestAnimationFrame(() => nameRef.current?.focus())
  }

  useEffect(() => {
    if (mode === 'create' && isOptionType && drafts.length === 0)
      setDrafts([newDraft(0, type === 'status' ? 'active' : undefined)])
  }, [mode, isOptionType, drafts.length, type])

  // The default widget edits against the attribute as it will be saved —
  // new options get the ids the server will derive, so a picked default
  // points at the right id before the attribute exists.
  const previewDef = useMemo<RegistryEntry>(() => {
    const taken = drafts.flatMap((d) => (d.id ? [d.id] : []))
    const newIds = deriveOptionIds(
      drafts.filter((d) => !d.id).map((d) => d.label),
      taken,
    )
    let n = 0
    return {
      slug: 'default',
      name: 'Default',
      type,
      isSystem: false,
      options: {
        options: drafts
          .filter((d) => d.label.trim())
          .map((d) => ({
            id: d.id ?? newIds[n++],
            label: d.label,
            ...(d.group ? { group: d.group } : {}),
            color: d.color,
            ...(d.archived ? { archived: true } : {}),
          })),
        max,
        code,
        ...(targetKind ? { targetKind } : {}),
        ...(targetObjectId ? { targetObjectId } : {}),
        multi,
      },
    }
  }, [drafts, type, max, code, targetKind, targetObjectId, multi])

  function buildDefault(): unknown {
    if (dflt === null || dflt === undefined || dflt === '') return null
    if (NUMBER_LIKE.has(type)) {
      const n = Number(dflt)
      return Number.isFinite(n) ? n : null
    }
    return dflt
  }

  async function submit(confirmedCode?: string) {
    setError(null)
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Name the attribute.')
      nameRef.current?.focus()
      return
    }
    if (isOptionType && !drafts.some((d) => d.label.trim())) {
      setError('Give at least one option.')
      return
    }
    if (type === 'record_reference' && !target) {
      setError('Pick what the relationship points at.')
      return
    }
    // A currency relabel changes how every stored amount reads (§3): the
    // warning comes before the write, once, here.
    if (
      mode === 'edit' &&
      type === 'currency' &&
      code !== (stored.code ?? 'USD') &&
      confirmedCode !== code
    ) {
      setPendingCode(code)
      return
    }
    setPending(true)
    try {
      const optionPayload = drafts
        .filter((d) => d.label.trim())
        .map((d) => ({
          ...(d.id ? { id: d.id } : {}),
          label: d.label.trim(),
          ...(type === 'status' ? { group: d.group ?? 'active' } : {}),
          color: d.color,
          ...(d.archived ? { archived: true } : {}),
        }))
      const defaultValue = buildDefault()
      if (mode === 'create') {
        await createAttribute({
          data: {
            ...(objectId ? { objectId } : { objectKind }),
            name: trimmed,
            description: description.trim() || undefined,
            type: type as Parameters<typeof createAttribute>[0]['data']['type'],
            options: isOptionType ? optionPayload : undefined,
            config: {
              ...(type === 'currency' ? { code } : {}),
              ...(type === 'rating' ? { max } : {}),
              ...(type === 'number' ? { precision } : {}),
              ...(type === 'record_reference' && targetKind
                ? { targetKind, multi }
                : type === 'record_reference' && targetObjectId
                  ? { targetObjectId, multi }
                  : {}),
            },
            default: defaultValue ?? undefined,
            required,
          },
        })
        toast(`${trimmed} added`)
      } else if (attr) {
        await updateAttribute({
          data: {
            id: attr.id,
            ...(trimmed !== attr.name ? { name: trimmed } : {}),
            ...(description.trim() !== (attr.description ?? '')
              ? { description: description.trim() || null }
              : {}),
            ...(required !== Boolean(stored.required) ? { required } : {}),
            ...(isOptionType ? { options: optionPayload } : {}),
            config: {
              ...(type === 'currency' && code !== (stored.code ?? 'USD')
                ? { code }
                : {}),
              ...(type === 'rating' && max !== (stored.max ?? 5)
                ? { max }
                : {}),
              ...(type === 'number' && precision !== (stored.precision ?? 0)
                ? { precision }
                : {}),
              ...(JSON.stringify(dflt) !==
              JSON.stringify(stored.default ?? null)
                ? { default: dflt }
                : {}),
            },
          },
        })
        toast(`${trimmed} saved`)
      }
      onDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  const slot = (() => {
    switch (type) {
      case 'number':
        return (
          <Field label="Decimals" htmlFor="attr-precision">
            <select
              id="attr-precision"
              value={precision}
              onChange={(e) => setPrecision(Number(e.target.value))}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-ui shadow-xs focus-ring"
            >
              {[0, 1, 2, 3, 4].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
        )
      case 'currency':
        return (
          <Field label="Currency" htmlFor="attr-code">
            <select
              id="attr-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-ui shadow-xs focus-ring"
            >
              {[...new Set([code, ...CURRENCIES])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {mode === 'edit' && code !== (stored.code ?? 'USD') ? (
              <p className="text-label text-muted-foreground">
                Changes how every stored amount reads. Nothing is converted.
              </p>
            ) : null}
          </Field>
        )
      case 'rating':
        return (
          <Field label="Out of" htmlFor="attr-max">
            <select
              id="attr-max"
              value={max}
              onChange={(e) => setMax(Number(e.target.value))}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-ui shadow-xs focus-ring"
            >
              {[3, 4, 5, 6, 7, 8, 9, 10].map((m) => (
                <option key={m} value={m}>
                  {m} stars
                </option>
              ))}
            </select>
            {mode === 'edit' && max < (stored.max ?? 5) ? (
              <p className="text-label text-muted-foreground">
                Lowering is refused while any record rates above {max}.
              </p>
            ) : null}
          </Field>
        )
      case 'select':
      case 'multi_select':
      case 'status':
        return (
          <div className="space-y-1.5 sm:col-span-2">
            <span className="text-ui font-medium">Options</span>
            <OptionListEditor
              type={type}
              drafts={drafts}
              onChange={setDrafts}
            />
          </div>
        )
      case 'record_reference':
        return mode === 'edit' ? (
          <p className="text-ui text-muted-foreground sm:col-span-2">
            Points at{' '}
            <span className="text-foreground">
              {stored.targetKind
                ? { company: 'Company', person: 'Person', deal: 'Deal' }[
                    stored.targetKind
                  ]
                : 'one of your objects'}
            </span>
            {stored.multi ? ', several at once' : ', one at a time'}. Fixed
            since creation — changing it would invalidate every stored link.
          </p>
        ) : (
          <>
            <Field label="Points at" htmlFor="attr-target">
              <select
                id="attr-target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-ui shadow-xs focus-ring"
              >
                <option value="">Pick an object…</option>
                {objects.map((o) => (
                  <option key={o.id} value={targetValue(o)}>
                    {o.singular}
                  </option>
                ))}
              </select>
            </Field>
            <CheckRow
              id="attr-multi"
              checked={multi}
              onChange={setMulti}
              label="Multiple values"
              hint="Several records at once, like People on a deal"
            />
          </>
        )
      default:
        return null
    }
  })()

  const defaultWidget = (() => {
    if (type === 'record_reference' && !target)
      return (
        <p className="text-label text-muted-foreground">
          Pick what it points at first.
        </p>
      )
    if (TEXT_LIKE.has(type) || NUMBER_LIKE.has(type))
      return (
        <Input
          id="attr-default"
          type={NUMBER_LIKE.has(type) ? 'number' : 'text'}
          inputMode={NUMBER_LIKE.has(type) ? 'decimal' : undefined}
          value={dflt == null ? '' : String(dflt)}
          placeholder="None"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDflt(e.target.value || null)}
          className={cn(NUMBER_LIKE.has(type) && 'numeric')}
        />
      )
    if (type === 'date')
      return (
        <div className="space-y-2">
          <Segmented
            value={relative ? 'relative' : 'fixed'}
            options={[
              { id: 'fixed', label: 'A date' },
              { id: 'relative', label: 'Relative to creation' },
            ]}
            onChange={(v) => {
              setRelative(v === 'relative')
              setDflt(v === 'relative' ? 'P7D' : null)
            }}
          />
          {relative ? (
            <select
              id="attr-default"
              value={isDuration(dflt) ? dflt : 'P7D'}
              onChange={(e) => setDflt(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-ui shadow-xs focus-ring"
            >
              {RELATIVE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id="attr-default"
              type="date"
              value={typeof dflt === 'string' && !isDuration(dflt) ? dflt : ''}
              onChange={(e) => setDflt(e.target.value || null)}
            />
          )}
        </div>
      )
    if (type === 'actor_reference')
      return (
        <div className="space-y-2">
          <CheckRow
            id="attr-current-user"
            checked={dflt === 'current-user'}
            onChange={(on) => setDflt(on ? 'current-user' : null)}
            label="Whoever creates the record"
            hint="Skipped when a sync creates it — nobody was there"
          />
          {dflt !== 'current-user' ? (
            <ValueEditor
              def={previewDef}
              value={dflt}
              variant="field"
              onSave={setDflt}
            />
          ) : null}
        </div>
      )
    // select / multi / status / rating / checkbox / record_reference share
    // the record's own editor, so the default looks exactly like the value.
    return (
      <ValueEditor
        def={previewDef}
        value={dflt}
        variant="field"
        onSave={setDflt}
      />
    )
  })()

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          void submit()
        }
      }}
      className="space-y-5"
    >
      <DialogHeader>
        <DialogTitle>
          {mode === 'create' ? 'New attribute' : `Edit ${attr?.name}`}
        </DialogTitle>
        <DialogDescription>
          {mode === 'create'
            ? `Your own field on every ${objectLabel.toLowerCase()} — it becomes a column and a record field.`
            : 'Type is fixed; everything else is yours to change.'}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="attr-type">
          {mode === 'create' ? (
            <TypePicker value={meta} onPick={pickType} />
          ) : (
            <span className="flex h-9 items-center gap-2 text-ui">
              <meta.icon
                className="size-4 text-muted-foreground"
                strokeWidth={1.75}
              />
              {meta.label}
            </span>
          )}
        </Field>
        <Field label="Name" htmlFor="attr-name">
          <Input
            ref={nameRef}
            id="attr-name"
            value={name}
            autoFocus={mode === 'edit'}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              type === 'rating'
                ? 'Founder quality'
                : `A ${meta.label.toLowerCase()} field`
            }
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="attr-description"
          className="sm:col-span-2"
          optional
        >
          <Input
            id="attr-description"
            value={description}
            spellCheck={false}
            autoComplete="off"
            placeholder="What this field means, for whoever fills it in"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>

      {slot ? (
        <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
          {slot}
        </div>
      ) : null}

      <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
        <Field label="Default" htmlFor="attr-default" optional>
          {defaultWidget}
        </Field>
        {type !== 'checkbox' ? (
          <div className="flex items-end">
            <CheckRow
              id="attr-required"
              checked={required}
              onChange={setRequired}
              label="Required"
              hint="Once set, it can't be cleared"
            />
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter className="items-center">
        <DialogClose asChild>
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending} title="⌘↵">
          {mode === 'create' ? (
            <Plus className="size-4" strokeWidth={2} />
          ) : (
            <Check className="size-4" strokeWidth={2} />
          )}
          {pending
            ? mode === 'create'
              ? 'Creating…'
              : 'Saving…'
            : mode === 'create'
              ? 'Create attribute'
              : 'Save'}
          <kbd className="ml-1 rounded border border-primary-foreground/30 px-1 text-micro font-normal opacity-80">
            ⌘↵
          </kbd>
        </Button>
      </DialogFooter>

      {/* Currency relabel confirmation — the one config edit that changes
          how every stored value reads. */}
      <Dialog
        open={pendingCode !== null}
        onOpenChange={(o) => {
          if (!o) setPendingCode(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Show {name.trim() || attr?.name} in {pendingCode}?
            </DialogTitle>
            <DialogDescription>
              This changes how all existing values display — every amount
              already stored will read as {pendingCode}. Nothing is converted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingCode(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                const c = pendingCode
                setPendingCode(null)
                if (c) void submit(c)
              }}
            >
              Change to {pendingCode}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  )
}

function TypePicker({
  value,
  onPick,
}: {
  value: TypeMeta
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    // Modal: the parent Dialog locks scrolling for everything outside
    // itself, and this popover portals outside it — without its own lock,
    // wheel events over the list are swallowed and it can't scroll.
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger
        id="attr-type"
        autoFocus
        aria-label="Type"
        className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-ui shadow-xs focus-ring"
      >
        <value.icon
          className="size-4 text-muted-foreground"
          strokeWidth={1.75}
        />
        <span className="flex-1">{value.label}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search types…" autoFocus />
          <CommandList className="max-h-64">
            <CommandEmpty>No type matches.</CommandEmpty>
            <CommandGroup>
              {TYPES.map((t) => (
                <CommandItem
                  key={t.id}
                  value={`${t.label} ${t.keywords ?? ''}`}
                  onSelect={() => {
                    onPick(t.id)
                    setOpen(false)
                  }}
                >
                  <t.icon className="size-4" strokeWidth={1.75} />
                  <span className="flex-1">
                    {t.label}
                    <span className="ml-2 text-label text-muted-foreground">
                      {t.hint}
                    </span>
                  </span>
                  {t.id === value.id ? (
                    <Check className="size-3.5" strokeWidth={2} />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function Field({
  label,
  htmlFor,
  optional,
  className,
  children,
}: {
  label: string
  htmlFor: string
  optional?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {optional ? (
          <span className="ml-1 font-normal text-muted-foreground">
            optional
          </span>
        ) : null}
      </Label>
      {children}
    </div>
  )
}

/** A checkbox whose whole row is the hit area — no dead zone between box and text. */
function CheckRow({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label
      htmlFor={id}
      className="flex min-h-9 cursor-pointer touch-manipulation items-start gap-2.5 rounded-md py-1.5"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary focus-ring"
      />
      <span className="flex flex-col">
        <span className="text-ui">{label}</span>
        {hint ? (
          <span className="text-label text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </label>
  )
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<{ id: string; label: string }>
  onChange: (id: string) => void
}) {
  return (
    <div
      role="radiogroup"
      className="flex h-9 w-fit items-center gap-0.5 rounded-md border border-input p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'h-full rounded px-2.5 text-ui font-medium focus-ring transition-colors duration-150 ease-out-quart',
            value === o.id
              ? 'bg-selected text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
