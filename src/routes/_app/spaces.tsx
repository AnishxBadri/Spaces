import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Layers, Plus } from 'lucide-react'
import { useState } from 'react'
import { LedgerRow, LedgerSection } from '#/components/ledger-section'
import { KeyHint, PageHeader } from '#/components/page-header'
import { TemplatePicker } from '#/components/templates'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { applySpaceTemplate, createSpace, listSpaces } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/spaces')({
  loader: () => listSpaces(),
  component: SpacesPage,
})

type SpaceRow = Awaited<ReturnType<typeof listSpaces>>[number]

/** The three fixed lanes every market-map row ends on. */
const LANE = 'w-20 shrink-0 text-right'

/** A count in its lane: ink when there is something, a dash when not. */
function Lane({ n }: { n: number }) {
  return (
    <span
      className={cn(
        LANE,
        'mono text-micro max-md:hidden',
        n > 0 ? 'text-foreground' : 'text-graphite',
      )}
    >
      {n > 0 ? n : '—'}
    </span>
  )
}

function SpacesPage() {
  const spaces = Route.useLoaderData()
  const [open, setOpen] = useState(false)
  useHotkey('s', () => setOpen(true))

  const nested = spaces.filter((s) => s.depth > 0).length

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Spaces"
        description={
          <>
            <span>
              {spaces.length} space{spaces.length === 1 ? '' : 's'}
            </span>
            <span>{nested} nested</span>
          </>
        }
        action={
          /* Always available — the first-run creator below only makes bare
             top-level spaces; scaffold stamping and nesting live here. */
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" strokeWidth={2} />
            New space
            <KeyHint>S</KeyHint>
          </Button>
        }
      />

      <div className="px-8 pt-6 pb-8">
        {spaces.length === 0 ? (
          <MarketsCreator />
        ) : (
          <LedgerSection
            label="Market map"
            count={`${spaces.length} · ${nested} nested`}
            link={
              /* Lane heads, aligned with the rows' fixed lanes. */
              <span
                aria-hidden
                className="flex tracking-[0.08em] uppercase max-md:hidden"
              >
                <span className={LANE}>Companies</span>
                <span className={LANE}>Memos</span>
                <span className={LANE}>Terms</span>
              </span>
            }
          >
            {spaces.map((s) => (
              <LedgerRow key={s.id}>
                <Link
                  to="/spaces/$spaceId"
                  params={{ spaceId: s.id }}
                  className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 transition-colors hover:bg-bone"
                  style={{ paddingLeft: `${s.depth * 24}px` }}
                >
                  {s.depth > 0 ? (
                    <span className="w-3.5 shrink-0 text-center mono text-label text-graphite">
                      ›
                    </span>
                  ) : (
                    <Layers
                      className="size-3.5 shrink-0 text-foreground"
                      strokeWidth={1.75}
                    />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-ui',
                      s.depth === 0 && 'font-medium',
                    )}
                  >
                    {s.name}
                  </span>
                  <Lane n={s.companies} />
                  <Lane n={s.memos} />
                  <Lane n={s.terms} />
                </Link>
              </LedgerRow>
            ))}
            {/* The composer row: adding never starts from a corner button. */}
            <LedgerRow last>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:bg-bone"
              >
                <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
                  +
                </span>
                <span className="min-w-0 flex-1 truncate text-ui text-graphite">
                  New space… nest it under a parent, or stamp a saved breakdown
                </span>
                <span className="shrink-0 text-graphite">
                  <KeyHint>S</KeyHint>
                </span>
              </button>
            </LedgerRow>
          </LedgerSection>
        )}
      </div>

      <CreateSpaceDialog spaces={spaces} open={open} onOpenChange={setOpen} />
    </div>
  )
}

/**
 * The active empty state (decided 2026-08-07): instead of describing
 * spaces, it asks the one question every investor can answer on day zero —
 * "what markets do you look at?" — and turns the answers into the first
 * top-level spaces. The mental model is taught by using it, on the surface
 * where space creation actually lives, not in the setup wizard.
 */
function MarketsCreator() {
  const router = useRouter()
  const [names, setNames] = useState(['', '', ''])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // Dedupe case-insensitively — two "Fintech" inputs are one market, and
    // the second would trip the slug-per-parent unique index.
    const seen = new Set<string>()
    const filled = names
      .map((n) => n.trim())
      .filter(Boolean)
      .filter((n) => {
        const key = n.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    if (filled.length === 0) {
      setError('Name at least one market.')
      return
    }
    setPending(true)
    setError(null)
    const failed: Array<string> = []
    for (const name of filled) {
      try {
        await createSpace({ data: { name } })
      } catch {
        failed.push(name)
      }
    }
    if (failed.length > 0) {
      setError(`Could not create: ${failed.join(', ')}. The rest are in.`)
      setPending(false)
    }
    if (failed.length < filled.length) void router.invalidate()
  }

  return (
    <div className="flex max-w-100 flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="font-serif text-xl leading-6 font-semibold">
          What markets do you look at?
        </h2>
        <p className="text-ui leading-5 text-graphite">
          Each one becomes a space — a node in your market map. Memos file into
          them, companies get tagged into them, and your glossary grows inside
          them. Rename, nest, or delete freely later.
        </p>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
        {names.map((n, i) => (
          <Input
            key={i}
            value={n}
            autoFocus={i === 0}
            onChange={(e) =>
              setNames((s) => s.map((v, j) => (j === i ? e.target.value : v)))
            }
            placeholder={
              ['Climate — industrial heat', 'Vertical SaaS', 'Space infra'][i]
            }
            aria-label={`Market ${i + 1}`}
          />
        ))}
        {error ? (
          <p
            role="alert"
            className="flex items-center gap-2 text-ui text-destructive"
          >
            <span aria-hidden className="size-2 shrink-0 bg-destructive" />
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Creating…' : 'Create my map'}
          <KeyHint>↵</KeyHint>
        </Button>
        <p className="mono text-micro text-graphite">
          three to start · blanks are skipped · duplicates fold into one
        </p>
      </form>
    </div>
  )
}

function CreateSpaceDialog({
  spaces,
  open,
  onOpenChange,
}: {
  spaces: Array<SpaceRow>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
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
            ...(parentId ? { parentId } : {}),
          },
        })
      } else {
        await createSpace({
          data: { name, ...(parentId ? { parentId } : {}) },
        })
      }
      onOpenChange(false)
      setScaffold(null)
      void router.invalidate()
    } catch {
      setError('Could not create the space.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            A market or theme to research. Nest it to build the map.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          {scaffold ? (
            <span className="flex items-center gap-1.5 text-label text-graphite">
              Scaffold:{' '}
              <span className="font-medium text-foreground">
                {scaffold.name}
              </span>
              <button
                type="button"
                onClick={() => setScaffold(null)}
                className="focus-ring rounded-md text-graphite hover:text-foreground"
                aria-label="Clear scaffold"
              >
                ×
              </button>
            </span>
          ) : (
            <span className="text-label text-graphite">
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
              className="focus-ring h-8 w-full rounded-md border border-rule bg-transparent px-2.5 text-ui"
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
