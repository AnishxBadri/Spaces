import { useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import {
  fieldSpanClass,
  ValueEditor,
} from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { KeyHint } from '#/components/page-header'
import { TemplatePicker } from '#/components/templates'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { createCompany } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'
import { jsonRecord } from '@spaces/core/json'

/**
 * The New company dialog: name and domain (the identity it matches on), the
 * registry's other fields, and a template to pre-fill them. A match attaches
 * rather than duplicating, and says so.
 */
export function CreateCompanyDialog({
  registry,
  trigger,
  hotkey,
}: {
  registry: Array<RegistryEntry>
  /** The control that opens it; the head's New company button by default. */
  trigger?: ReactNode
  /** Bare key that opens it from the page — printed in the default trigger. */
  hotkey?: string
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [values, setValues] = useState<Record<string, unknown>>({})

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!name.trim() && !domain.trim()) {
      setError('Give a name or a domain — either identifies the company.')
      return
    }
    setPending(true)
    try {
      // Initial values ride the create call: the server writes them before
      // defaults fill the blanks, so a value typed here always wins.
      const result = await createCompany({
        data: {
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(domain.trim() ? { domain: domain.trim() } : {}),
          values: Object.fromEntries(
            Object.entries(values).filter(
              ([, v]) => v !== null && v !== undefined,
            ),
          ),
        },
      })
      setOpen(false)
      setName('')
      setDomain('')
      setValues({})
      if (result.action === 'attached') {
        toast(`Matched existing company — ${result.name}`, {
          description: `Same ${result.matchedOn}. No duplicate created.`,
        })
      } else {
        toast(`${result.name} added`)
      }
      void router.invalidate()
      // The rows come from a keyed query now, not from the loader alone —
      // and the head's count comes from the loader, so both.
      void queryClient.invalidateQueries({ queryKey: ['company-records'] })
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not add the company.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus className="size-4" strokeWidth={2} />
            New company
            {hotkey ? <KeyHint>{hotkey.toUpperCase()}</KeyHint> : null}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
        </DialogHeader>
        {/* Pre-fills the fields below, visibly and editably — never writes. */}
        <div className="flex justify-end">
          <TemplatePicker
            kind="record"
            objectKind="company"
            context="company"
            onPick={(t) => {
              const tv = jsonRecord(jsonRecord(t.body).values)
              setValues((s) => ({ ...tv, ...s }))
            }}
          />
        </div>
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="company-name">Name</Label>
            <Input
              id="company-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="Orbital Composites"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-domain">Domain</Label>
            <Input
              id="company-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="orbitalcomposites.com"
            />
          </div>

          {/* Domains have their own field above, the key the create matches on. */}
          {registry
            .filter((def) => def.options?.identityKey === undefined)
            .map((def) => (
              <div
                key={def.slug}
                className={cn('space-y-1.5', fieldSpanClass(def))}
              >
                <Label>{def.name}</Label>
                <ValueEditor
                  def={def}
                  value={values[def.slug] ?? null}
                  variant="field"
                  onSave={(v) => setValues((s) => ({ ...s, [def.slug]: v }))}
                />
              </div>
            ))}

          {error ? (
            <p role="alert" className="text-ui text-destructive sm:col-span-2">
              {error}
            </p>
          ) : null}

          <DialogFooter className="sm:col-span-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Create company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
