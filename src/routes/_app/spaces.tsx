import { createFileRoute, useRouter } from '@tanstack/react-router'
import { ChevronRight, Layers, Plus } from 'lucide-react'
import { useState } from 'react'
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
import { createSpace, listSpaces } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/spaces')({
  loader: () => listSpaces(),
  component: SpacesPage,
})

type SpaceRow = Awaited<ReturnType<typeof listSpaces>>[number]

function SpacesPage() {
  const spaces = Route.useLoaderData()

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 md:px-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Spaces</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            The shared map of markets you work — taxonomy first, deals later.
          </p>
        </div>
        {spaces.length > 0 ? <CreateSpaceDialog spaces={spaces} /> : null}
      </header>

      {spaces.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No spaces yet"
          body="Spaces are the market map — Aerospace, then In-space Manufacturing inside it. Notes, sources, companies, and theses all hang off them."
          action={<CreateSpaceDialog spaces={spaces} />}
          hint="A seeded starter taxonomy is coming; custom spaces always stay first-class."
        />
      ) : (
        <ul className="mt-6 -mx-2">
          {spaces.map((s) => (
            <li key={s.id}>
              <div
                className={cn(
                  'group flex h-9 items-center gap-2 rounded-md px-2 text-[13px] hover:bg-accent',
                )}
                style={{ paddingLeft: `${8 + s.depth * 20}px` }}
              >
                {s.depth > 0 ? (
                  <ChevronRight
                    className="size-3 shrink-0 text-muted-foreground/60"
                    strokeWidth={2}
                  />
                ) : null}
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-muted-foreground/70">
                  {s.slug}
                </span>
              </div>
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
      await createSpace({
        data: { name, parentId: parentId || undefined },
      })
      setOpen(false)
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
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
            <p role="alert" className="text-[13px] text-destructive">
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
