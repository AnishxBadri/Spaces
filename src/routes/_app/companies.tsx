import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Building2, Copy, Globe, Plus } from 'lucide-react'
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
import {
  countOpenDuplicates,
  createCompany,
  listCompanies,
} from '#/lib/server-fns'

export const Route = createFileRoute('/_app/companies')({
  loader: async () => {
    const [companies, dupes] = await Promise.all([
      listCompanies(),
      countOpenDuplicates(),
    ])
    return { companies, openDuplicates: dupes.open }
  },
  component: CompaniesPage,
})

const dateFmt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

function CompaniesPage() {
  const { companies, openDuplicates } = Route.useLoaderData()

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 md:px-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">
            Companies
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Every company you track — deduped by domain, tagged into spaces,
            in a pipeline or not.
          </p>
        </div>
        {companies.length > 0 ? <CreateCompanyDialog /> : null}
      </header>

      {openDuplicates > 0 ? (
        <Link
          to="/dedupe"
          className="mt-4 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Copy className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
          <span className="font-medium tabular">{openDuplicates}</span>
          possible duplicate{openDuplicates === 1 ? '' : 's'} to review
          <span className="ml-auto text-xs text-muted-foreground">Review →</span>
        </Link>
      ) : null}

      {companies.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No companies yet"
          body="Add one by name or domain. The domain is identity — the same company arriving twice becomes one record, not two."
          action={<CreateCompanyDialog />}
          hint="Decks, mentions, and Gmail will create these automatically later — through the same dedupe gate."
        />
      ) : (
        <ul className="mt-6 -mx-2">
          {companies.map((c) => (
            <li key={c.id}>
              <Link
                to="/companies/$companyId"
                params={{ companyId: c.id }}
                className="group flex h-10 items-center gap-3 rounded-md px-2 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted">
                  <Building2
                    className="size-3.5 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {c.name}
                </span>
                {c.domain ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Globe className="size-3" strokeWidth={1.75} />
                    {c.domain}
                  </span>
                ) : null}
                <span className="tabular w-24 text-right text-xs text-muted-foreground/80">
                  {dateFmt.format(new Date(c.createdAt))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CreateCompanyDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)
    const name = String(form.get('name')).trim()
    const domain = String(form.get('domain')).trim()
    if (!name && !domain) {
      setError('Give a name or a domain — either identifies the company.')
      return
    }
    setPending(true)
    try {
      const result = await createCompany({
        data: {
          name: name || undefined,
          domain: domain || undefined,
        },
      })
      setOpen(false)
      if (result.action === 'attached') {
        toast(`Matched existing company — ${result.name}`, {
          description: `Same ${result.matchedOn}. No duplicate created.`,
        })
      } else {
        toast(`${result.name} added`)
      }
      router.invalidate()
    } catch {
      setError('Could not add the company.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" strokeWidth={2} />
          New company
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
          <DialogDescription>
            Domain is the strongest identity — add it when you know it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="company-name">Name</Label>
            <Input
              id="company-name"
              name="name"
              autoFocus
              placeholder="Orbital Composites"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-domain">Domain</Label>
            <Input
              id="company-domain"
              name="domain"
              placeholder="orbitalcomposites.com"
            />
          </div>

          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
