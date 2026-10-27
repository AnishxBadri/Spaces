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
import { Select } from '#/components/ui/select'
import { createPerson } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import { jsonRecord } from '@spaces/core/json'

type CompanyPick = { id: string; name: string }

/**
 * The New person window: a name and an email. The email's domain names the
 * company, set under `More fields ›` beside the registry's other fields; an
 * email another person holds is refused here, with the way to them.
 */
export function CreatePersonDialog({
  companies,
  registry,
  hotkey,
  trigger,
}: {
  companies: ReadonlyArray<CompanyPick>
  registry: Array<RegistryEntry>
  /** Bare key that opens it from the page — in the trigger's tooltip. */
  hotkey?: string
  /** The control that opens it; the head's New person button by default. */
  trigger?: ReactNode
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { today } = useClock()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [more, setMore] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  // The company the reader picked, or the one the email inferred; an
  // inferred pick follows the email, a picked one is the reader's.
  const [company, setCompany] = useState<{
    pick: CompanyPick
    inferred: boolean
  } | null>(null)
  const identity = useIdentityCheck('email')
  // Companies has its picker and Email its field, the key the create
  // matches on; `createPerson` writes both.
  const moreDefs = registry.filter(
    (def) => def.slug !== 'companies' && def.options?.identityKey === undefined,
  )
  const companyItems = [
    { value: '', label: 'None' },
    ...companies.map((c) => ({ value: c.id, label: c.name })),
    ...(company && !companies.some((c) => c.id === company.pick.id)
      ? [{ value: company.pick.id, label: company.pick.name }]
      : []),
  ]

  function reset() {
    setName('')
    setEmail('')
    setMore(false)
    setValues({})
    setCompany(null)
    setError(null)
    identity.clear()
  }

  /** The server reads the email: whose it is, and whose its domain is. */
  async function checkEmail(typed: string) {
    const match = await identity.check(typed)
    setCompany((cur) => {
      if (cur !== null && !cur.inferred) return cur
      return match?.company ? { pick: match.company, inferred: true } : null
    })
    return match
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError('Name the person.')
      return
    }
    setPending(true)
    try {
      // Asked again at submit: an email typed and submitted without a blur
      // has not been checked yet, and its company not inferred.
      let companyId = company?.pick.id ?? null
      if (email.trim()) {
        const match = await checkEmail(email)
        if (match?.owner) return
        if (company === null || company.inferred)
          companyId = match?.company?.id ?? null
      }
      // Initial values ride the create call: the server writes them before
      // defaults fill the blanks, so a value typed here always wins.
      const result = await createPerson({
        data: {
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(companyId ? { companyId } : {}),
          values: filledValues(values),
        },
      })
      setOpen(false)
      reset()
      if (result.action === 'attached')
        toast(`Matched existing person — ${result.name}`, {
          description: `Same ${result.matchedOn}. No duplicate created.`,
        })
      else toast(`${result.name} added`)
      void router.invalidate()
      // The rows come from a keyed query, not from the loader alone.
      void queryClient.invalidateQueries({ queryKey: ['people-records'] })
    } catch {
      setError('Could not add the person.')
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
          <Button shortcut={hotkey?.toUpperCase()}>New person</Button>
        )}
      </DialogTrigger>
      <DialogContent
        size="m"
        className="max-h-[85vh] overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>New person</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="person-name">Name</Label>
            <Input
              id="person-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="Awais Ahmed"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="person-email">Email</Label>
            <Input
              id="person-email"
              type="email"
              className="mono"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                identity.clear()
              }}
              onBlur={() => void checkEmail(email)}
              spellCheck={false}
              autoComplete="off"
              placeholder="awais@pixxel.space"
            />
          </div>
          {identity.owner ? (
            <IdentityRefusal
              owner={identity.owner}
              identityKey="email"
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
                objectKind="person"
                context="person"
                onPick={(t) => {
                  const tv = jsonRecord(jsonRecord(t.body).values)
                  setValues((s) => ({ ...tv, ...filledValues(s) }))
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="person-company">Company</Label>
              <Select
                id="person-company"
                value={company?.pick.id ?? ''}
                onChange={(id) => {
                  const item = companyItems.find((c) => c.value === id)
                  setCompany(
                    id === '' || item === undefined
                      ? null
                      : { pick: { id, name: item.label }, inferred: false },
                  )
                }}
                items={companyItems}
                width="content"
                placeholder="None"
                searchPlaceholder="Search companies…"
                emptyLabel="No company matches."
                className="bg-transparent text-body"
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
              {pending ? 'Adding…' : 'Create person'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
