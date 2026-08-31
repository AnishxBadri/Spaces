import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { createAttribute } from '#/lib/server-fns'
import type { ReactNode } from 'react'

const TYPE_CHOICES = [
  { id: 'text', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'currency', label: 'Currency' },
  { id: 'date', label: 'Date' },
  { id: 'checkbox', label: 'Checkbox' },
  { id: 'select', label: 'Select' },
  { id: 'multi_select', label: 'Multi-select' },
  { id: 'rating', label: 'Rating' },
  { id: 'url', label: 'URL' },
  { id: 'email', label: 'Email' },
  { id: 'phone', label: 'Phone' },
] as const

type TypeId = (typeof TYPE_CHOICES)[number]['id']

/** "+ Add column" / "+ Add attribute" — creates a custom attribute inline. */
export function AttributeCreateDialog({
  objectKind,
  trigger,
  onCreated,
}: {
  objectKind: 'company' | 'person' | 'deal'
  trigger: ReactNode
  onCreated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<TypeId>('text')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const needsOptions = type === 'select' || type === 'multi_select'

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)
    const name = String(form.get('name')).trim()
    if (!name) return setError('Name the attribute.')
    const optionLabels = needsOptions
      ? String(form.get('options') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined
    if (needsOptions && (!optionLabels || optionLabels.length === 0)) {
      return setError('Give at least one option (comma-separated).')
    }
    setPending(true)
    try {
      await createAttribute({
        data: { objectKind, name, type, optionLabels },
      })
      setOpen(false)
      toast(`${name} added`)
      onCreated()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not create attribute',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New attribute</DialogTitle>
          <DialogDescription>
            Your own field on every {objectKind} — it becomes a column and a
            record field.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="attr-name">Name</Label>
            <Input
              id="attr-name"
              name="name"
              autoFocus
              required
              placeholder="Founder quality"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="attr-type">Type</Label>
            <select
              id="attr-type"
              value={type}
              onChange={(e) => setType(e.target.value as TypeId)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-body shadow-xs focus-ring"
            >
              {TYPE_CHOICES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {needsOptions ? (
            <div className="space-y-1.5">
              <Label htmlFor="attr-options">Options</Label>
              <Input
                id="attr-options"
                name="options"
                placeholder="Low, Medium, High"
                aria-describedby="attr-options-hint"
              />
              <p
                id="attr-options-hint"
                className="text-label text-muted-foreground"
              >
                Comma-separated.
              </p>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              <Plus className="size-4" strokeWidth={2} />
              {pending ? 'Creating…' : 'Create attribute'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
