import { useNavigate } from '@tanstack/react-router'
import { Check, Plus } from 'lucide-react'
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
import { suggestPlural } from '#/lib/object-nouns'
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
            icon: icon ?? undefined,
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
        <div className="space-y-1.5">
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
        <div className="space-y-1.5">
          <Label htmlFor="obj-plural">Plural</Label>
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

      <div className="space-y-1.5">
        <span className="text-ui font-medium">Icon</span>
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
                  'flex size-9 touch-manipulation items-center justify-center rounded-md border focus-ring transition-colors duration-150 ease-out-quart',
                  on
                    ? 'border-primary bg-selected text-foreground'
                    : 'border-input text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" strokeWidth={1.75} />
              </button>
            )
          })}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending} title="⌘↵">
          {props.mode === 'create' ? (
            <Plus className="size-4" strokeWidth={2} />
          ) : (
            <Check className="size-4" strokeWidth={2} />
          )}
          {pending
            ? 'Saving…'
            : props.mode === 'create'
              ? 'Create object'
              : 'Save'}
          <kbd className="ml-1 rounded border border-primary-foreground/30 px-1 text-micro font-normal opacity-80">
            ⌘↵
          </kbd>
        </Button>
      </DialogFooter>
    </form>
  )
}
