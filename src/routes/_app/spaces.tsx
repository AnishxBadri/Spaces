import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ChevronRight, Layers, Plus } from 'lucide-react'
import { useState } from 'react'
import { EmptyState } from '#/components/empty-state'
import { TemplatePicker } from '#/components/templates'
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
import { applySpaceTemplate, createSpace, listSpaces } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/spaces')({
  loader: () => listSpaces(),
  component: SpacesPage,
})

type SpaceRow = Awaited<ReturnType<typeof listSpaces>>[number]

function SpacesPage() {
  const spaces = Route.useLoaderData()

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 md:px-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-page font-semibold tracking-tight">Spaces</h1>
          <p className="mt-1 text-ui text-muted-foreground">
            The shared map of markets you work — taxonomy first, deals later.
          </p>
        </div>
        {spaces.length > 0 ? <CreateSpaceDialog spaces={spaces} /> : null}
      </header>

      {spaces.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No spaces yet"
          body="Spaces are the market map — Aerospace, then In-space Manufacturing inside it. Notes, sources, and companies all hang off them."
          action={<CreateSpaceDialog spaces={spaces} />}
          hint="The tree is yours — a few starter spaces ship, the rest you build as the research earns them."
        />
      ) : (
        <ul className="mt-6 -mx-2">
          {spaces.map((s) => (
            <li key={s.id}>
              <Link
                to="/spaces/$spaceId"
                params={{ spaceId: s.id }}
                className={cn(
                  'group flex h-9 items-center gap-2 rounded-md px-2 text-ui hover:bg-accent focus-ring',
                )}
                style={{ paddingLeft: `${8 + s.depth * 20}px` }}
              >
                {s.depth > 0 ? (
                  <ChevronRight
                    className="size-3 shrink-0 text-muted-foreground"
                    strokeWidth={2}
                  />
                ) : null}
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.slug}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CreateSpaceDialog({ spaces }: { spaces: Array<SpaceRow> }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [scaffold, setScaffold] = useState<{ id: string; name: string } | null>(
    null,
  )

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)
    const name = String(form.get('name')).trim()
    const parentId = String(form.get('parent') || '')
    if (!name) {
      setError('Name the space.')
      return
    }
    setPending(true)
    try {
      if (scaffold) {
        // Stamp the pattern: subtree + glossary, skip-existing. The tree it
        // creates is fully editable afterwards — copy, not reference.
        await applySpaceTemplate({
          data: {
            templateId: scaffold.id,
            name,
            parentId: parentId || undefined,
          },
        })
      } else {
        await createSpace({
          data: { name, parentId: parentId || undefined },
        })
      }
      setOpen(false)
      setScaffold(null)
      router.invalidate()
    } catch {
      setError('Could not create the space.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" strokeWidth={2} />
          New space
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            A market or theme to research. Nest it to build the map.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          {scaffold ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Scaffold:{' '}
              <span className="font-medium text-foreground">
                {scaffold.name}
              </span>
              <button
                type="button"
                onClick={() => setScaffold(null)}
                className="focus-ring rounded text-muted-foreground hover:text-foreground"
                aria-label="Clear scaffold"
              >
                ×
              </button>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Optionally stamp a saved market-breakdown pattern.
            </span>
          )}
          <TemplatePicker
            kind="space"
            context="space"
            onPick={(t) => setScaffold({ id: t.id, name: t.name })}
          />
        </div>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="space-name">Name</Label>
            <Input
              id="space-name"
              name="name"
              required
              autoFocus
              placeholder="Aerospace"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="space-parent">Parent</Label>
            <select
              id="space-parent"
              name="parent"
              defaultValue=""
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs focus-ring"
            >
              <option value="">None — top level</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {' '.repeat(s.depth * 3)}
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create space'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
