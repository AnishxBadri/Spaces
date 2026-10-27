import { useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import {
  filledValues,
  IdentityRefusal,
  MoreFields,
  RegistryField,
  useIdentityCheck,
  withTodayDates,
} from '#/components/create-window'
import { useClock } from '#/components/clock'
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
import { jsonRecord } from '@spaces/core/json'

/**
 * The New company window: a name and the domain it is known by. The
 * registry's other fields and a template wait behind `More fields ›`. A
 * domain another record holds is refused here, with the way to that record.
 */
export function CreateCompanyDialog({
  registry,
  trigger,
  hotkey,
}: {
  registry: Array<RegistryEntry>
  /** The control that opens it; the head's New company button by default. */
  trigger?: ReactNode
  /** Bare key that opens it from the page — in the default trigger's tooltip. */
  hotkey?: string
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { today } = useClock()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [more, setMore] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const identity = useIdentityCheck('domain')
  // Domains have their own field, the key the create matches on.
  const moreDefs = registry.filter(
    (def) => def.options?.identityKey === undefined,
  )

  function reset() {
    setName('')
    setDomain('')
    setMore(false)
    setValues({})
    setError(null)
    identity.clear()
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!name.trim() && !domain.trim()) {
      setError('Give a name or a domain.')
      return
    }
    setPending(true)
    try {
      // Asked again at submit: a domain typed and submitted without a blur
      // has not been checked yet.
      if (domain.trim() && (await identity.check(domain))?.owner) return
      // Initial values ride the create call: the server writes them before
      // defaults fill the blanks, so a value typed here always wins.
      const result = await createCompany({
        data: {
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(domain.trim() ? { domain: domain.trim() } : {}),
          values: filledValues(values),
        },
      })
      setOpen(false)
      reset()
      // The window refused a held domain; an attach here is a race lost to
      // another writer, and the toast says so.
      if (result.action === 'attached')
        toast(`Matched existing company — ${result.name}`, {
          description: `Same ${result.matchedOn}. No duplicate created.`,
        })
      else toast(`${result.name} added`)
      void router.invalidate()
      // The rows come from a keyed query and the head's count from the
      // loader, so both are refreshed.
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button shortcut={hotkey?.toUpperCase()}>New company</Button>
        )}
      </DialogTrigger>
      <DialogContent
        size="m"
        className="max-h-[85vh] overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
        </DialogHeader>
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
              className="mono"
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value)
                identity.clear()
              }}
              onBlur={() => void identity.check(domain)}
              spellCheck={false}
              autoComplete="off"
              placeholder="orbitalcomposites.com"
            />
          </div>
          {identity.owner ? (
            <IdentityRefusal
              owner={identity.owner}
              identityKey="domain"
              className="sm:col-span-2"
            />
          ) : null}

          <MoreFields
            open={more}
            onOpen={() => {
              setMore(true)
              setValues((s) => withTodayDates(moreDefs, s, today))
            }}
          >
            {/* Pre-fills the fields below, visibly and editably — never writes. */}
            <div className="flex justify-end sm:col-span-2">
              <TemplatePicker
                kind="record"
                objectKind="company"
                context="company"
                onPick={(t) => {
                  const tv = jsonRecord(jsonRecord(t.body).values)
                  setValues((s) => ({ ...tv, ...filledValues(s) }))
                }}
              />
            </div>
            {moreDefs.map((def) => (
              <RegistryField
                key={def.slug}
                def={def}
                value={values[def.slug]}
                onChange={(v) => setValues((s) => ({ ...s, [def.slug]: v }))}
              />
            ))}
          </MoreFields>

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
            <Button type="submit" disabled={pending || identity.owner !== null}>
              {pending ? 'Adding…' : 'Create company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
