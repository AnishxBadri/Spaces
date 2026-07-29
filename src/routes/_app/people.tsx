import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Building2, Plus, Users } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#/components/empty-state'
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
import { createPerson, listCompanies, listPeople } from '#/lib/server-fns'

export const Route = createFileRoute('/_app/people')({
  loader: async () => {
    const [people, companies] = await Promise.all([
      listPeople(),
      listCompanies(),
    ])
    return { people, companies }
  },
  component: PeoplePage,
})

function PeoplePage() {
  const { people, companies } = Route.useLoaderData()

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 md:px-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">People</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Founders, operators, co-investors — deduped by email, linked to
            their companies.
          </p>
        </div>
        {people.length > 0 ? <CreatePersonDialog companies={companies} /> : null}
      </header>

      {people.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No people yet"
          body="Add someone by name and email. Email is identity — the same person arriving from two directions becomes one record."
          action={<CreatePersonDialog companies={companies} />}
          hint="Gmail and calendar sync will create these automatically later — through the same dedupe gate."
        />
      ) : (
        <ul className="mt-6 -mx-2">
          {people.map((p) => (
            <li key={p.id}>
              <Link
                to="/people/$personId"
                params={{ personId: p.id }}
                className="group flex h-10 items-center gap-3 rounded-md px-2 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                  {p.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{p.name}</span>
                  {p.headline ? (
                    <span className="ml-2 text-muted-foreground">
                      {p.headline}
                    </span>
                  ) : null}
                </span>
                {p.company ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Building2 className="size-3" strokeWidth={1.75} />
                    {p.company.name}
                  </span>
                ) : null}
                {p.email ? (
                  <span className="hidden text-xs text-muted-foreground/80 sm:block">
                    {p.email}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CreatePersonDialog({
  companies,
}: {
  companies: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)
    const name = String(form.get('name')).trim()
    const email = String(form.get('email')).trim()
    const companyId = String(form.get('company') || '')
    if (!name) {
      setError('Name the person.')
      return
    }
    setPending(true)
    try {
      const result = await createPerson({
        data: {
          name,
          email: email || undefined,
          companyId: companyId || undefined,
        },
      })
      setOpen(false)
      if (result.action === 'attached') {
        toast(`Matched existing person — ${result.name}`, {
          description: `Same ${result.matchedOn}. No duplicate created.`,
        })
      } else {
        toast(`${result.name} added`)
      }
      router.invalidate()
    } catch {
      setError('Could not add the person.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" strokeWidth={2} />
          New person
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New person</DialogTitle>
          <DialogDescription>
            Email is the strongest identity — add it when you have it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="person-name">Name</Label>
            <Input
              id="person-name"
              name="name"
              required
              autoFocus
              placeholder="Awais Ahmed"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="person-email">Email</Label>
            <Input
              id="person-email"
              name="email"
              type="email"
              placeholder="awais@pixxel.space"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="person-company">Company</Label>
            <select
              id="person-company"
              name="company"
              defaultValue=""
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="">None</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add person'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
