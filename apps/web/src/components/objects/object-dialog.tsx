import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
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
import { KeyHint } from '#/components/page-header'
import { slugifyNoun, suggestPlural } from '#/lib/object-nouns'
import { OBJECT_ICONS, OBJECT_ICON_NAMES } from '#/lib/object-icons'
import { createObject, updateObject } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import type { ReactNode } from 'react'

/**
 * Object creation / rename (spec §9 birth contract): singular, plural
 * (suggested from the singular, always editable), optional icon. No slug
 * field — derived from the plural, frozen, hidden. Creation lands on the
 * object's attributes page, where the real work starts.
 */
export function ObjectDialog(
  props: {
    trigger?: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
    onSaved?: () => void
  } & (
    | { mode: 'create' }
    | {
        mode: 'edit'
        object: {
          id: string
          singular: string
          plural: string
          icon: string | null
        }
      }
  ),
) {
  const [selfOpen, setSelfOpen] = useState(false)
  const open = props.open ?? selfOpen
  const setOpen = props.onOpenChange ?? setSelfOpen
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {props.trigger ? (
        <DialogTrigger asChild>{props.trigger}</DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-md">
        {open ? (
          <ObjectForm
            {...props}
            onDone={(saved) => {
              setOpen(false)
              if (saved) props.onSaved?.()
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ObjectForm(
  props: {
    onDone: (saved: boolean) => void
  } & (
    | { mode: 'create' }
    | {
        mode: 'edit'
        object: {
          id: string
          singular: string
          plural: string
          icon: string | null
        }
      }
  ),
) {
  const navigate = useNavigate()
  const existing = props.mode === 'edit' ? props.object : null
  const [singular, setSingular] = useState(existing?.singular ?? '')
  const [plural, setPlural] = useState(existing?.plural ?? '')
  const [pluralTouched, setPluralTouched] = useState(Boolean(existing))
  const [icon, setIcon] = useState<string | null>(existing?.icon ?? 'boxes')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit() {
    setError(null)
    if (!singular.trim() || !plural.trim()) {
      setError('Give both nouns — the app uses each.')
      return
    }
    setPending(true)
    try {
      if (props.mode === 'create') {
        const { slug } = await createObject({
          data: {
            singular: singular.trim(),
            plural: plural.trim(),
            ...(icon === null ? {} : { icon }),
          },
        })
        toast(`${plural.trim()} created — now give it attributes`)
        props.onDone(true)
        void navigate({
          to: '/settings/objects/$objectSlug',
          params: { objectSlug: slug },
        })
      } else {
        await updateObject({
          data: {
            id: props.object.id,
            ...(singular.trim() !== props.object.singular
              ? { singular: singular.trim() }
              : {}),
            ...(plural.trim() !== props.object.plural
              ? { plural: plural.trim() }
              : {}),
            ...(icon !== props.object.icon ? { icon } : {}),
          },
        })
        toast(`${plural.trim()} saved`)
        props.onDone(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

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
          {props.mode === 'create' ? 'New object' : `Edit ${existing?.plural}`}
        </DialogTitle>
        <DialogDescription>
          {props.mode === 'create'
            ? 'A kind of record you keep — funds, LPs, hires. It gets its own attributes, list, and record pages.'
            : 'Rename freely. The web address stays what it was.'}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="obj-singular">Singular</Label>
          <Input
            id="obj-singular"
            value={singular}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="Fund"
            onChange={(e) => {
              setSingular(e.target.value)
              if (!pluralTouched) setPlural(suggestPlural(e.target.value))
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="obj-plural">
            Plural
            {!pluralTouched && plural ? (
              <span className="ml-2 font-normal text-graphite">guessed</span>
            ) : null}
          </Label>
          <Input
            id="obj-plural"
            value={plural}
            spellCheck={false}
            autoComplete="off"
            placeholder="Funds"
            onChange={(e) => {
              setPluralTouched(true)
              setPlural(e.target.value)
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Icon · 1-bit</Label>
        {/* Square tiles on a rule; the chosen one is ink with a paper mark. */}
        <div
          role="radiogroup"
          aria-label="Icon"
          className="flex flex-wrap gap-1.5"
        >
          {OBJECT_ICON_NAMES.map((name) => {
            const Icon = OBJECT_ICONS[name]
            const on = icon === name
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={name}
                title={name}
                onClick={() => setIcon(name)}
                className={cn(
                  'focus-ring flex size-8 touch-manipulation items-center justify-center border transition-colors duration-150 ease-out-quart',
                  on
                    ? 'border-hairline bg-hairline text-paper'
                    : 'border-rule text-foreground hover:border-hairline',
                )}
              >
                <Icon className="size-3.5" strokeWidth={1.75} />
              </button>
            )
          })}
        </div>
      </div>

      {/* The slug is derived and frozen — shown, never edited. */}
      <div className="flex flex-col gap-1 border border-rule bg-bone px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="field-label text-graphite">Slug</span>
          <span className="mono text-field text-graphite">
            {existing ? 'frozen' : 'derived · frozen after create'}
          </span>
        </div>
        <span className="truncate mono text-ui">
          /o/{existing ? existing.plural : slugifyNoun(plural) || '…'}
          {' · '}/o/{existing ? existing.plural : slugifyNoun(plural) || '…'}
          /&lt;id&gt;
        </span>
      </div>

      {error ? (
        <p
          role="alert"
          className="flex items-center gap-2 text-ui text-destructive"
        >
          <span aria-hidden className="size-2 shrink-0 bg-destructive" />
          {error}
        </p>
      ) : null}

      <DialogFooter
        note={
          props.mode === 'create'
            ? 'archive, never delete'
            : 'the web address stays what it was'
        }
      >
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" pending={pending}>
          {props.mode === 'create' ? (
            <Plus className="size-4" strokeWidth={2} />
          ) : null}
          {pending
            ? 'Saving…'
            : props.mode === 'create'
              ? 'Create object'
              : 'Save'}
          <KeyHint>⌘↵</KeyHint>
        </Button>
      </DialogFooter>
    </form>
  )
}
