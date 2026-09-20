import { ChevronDown, LayoutTemplate } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { listTemplates } from '#/lib/server-fns'

/**
 * Template application is manual plus a context hint (CONTEXT.md, 2026-08):
 * the picker is scoped by suggest_on — templates tagged for the surface
 * they're opened from sort first. Ordering, not automation; nothing
 * auto-creates.
 */

type TemplateRow = Awaited<ReturnType<typeof listTemplates>>[number]

export function TemplatePicker({
  kind,
  objectKind,
  context,
  label = 'From template',
  onPick,
}: {
  kind: 'note' | 'space' | 'record'
  objectKind?: 'company' | 'person' | 'deal'
  /** Entity kind of the surface this picker sits on — the suggest_on hint. */
  context?: string
  label?: string
  onPick: (template: TemplateRow) => void
}) {
  const [items, setItems] = useState<Array<TemplateRow> | null>(null)

  async function load() {
    if (items) return
    try {
      const rows = await listTemplates({ data: { kind, objectKind } })
      const sorted = context
        ? [...rows].sort(
            (a, b) =>
              Number(b.suggestOn.includes(context)) -
              Number(a.suggestOn.includes(context)),
          )
        : rows
      setItems(sorted)
    } catch {
      setItems([])
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onPointerDown={load} onFocus={load}>
        <Button size="sm" variant="outline">
          <LayoutTemplate className="size-3.5" strokeWidth={1.75} />
          {label}
          <ChevronDown className="size-3" strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : items.length === 0 ? (
          <DropdownMenuItem disabled>
            No templates yet — save one from an existing{' '}
            {kind === 'record' ? (objectKind ?? 'record') : kind}.
          </DropdownMenuItem>
        ) : (
          items.map((t) => {
            // The kind lane, drawn the way the notes index draws it
            // (SPA-109): quiet, lowercase, and blank for the default. A memo
            // template is legible before you stamp it; a plain-note template
            // has nothing to say, and space/record templates carry no note
            // kind at all.
            const genre = t.noteKind === 'note' ? null : t.noteKind
            return (
              <DropdownMenuItem key={t.id} onSelect={() => onPick(t)}>
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                {genre ? (
                  <span className="shrink-0 mono text-micro text-graphite">
                    {genre}
                  </span>
                ) : null}
              </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * "Save as template" — by-example capture, the only creation path. Renders
 * as a quiet menu-ish button; opens a one-field naming dialog.
 */
export function SaveAsTemplateAction({
  entityLabel,
  defaultName,
  onSave,
  trigger,
}: {
  entityLabel: 'note' | 'space' | 'company' | 'person' | 'deal'
  defaultName?: string
  onSave: (name: string) => Promise<void>
  trigger?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(defaultName ?? '')
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!name.trim()) return
    setPending(true)
    try {
      await onSave(name.trim())
      toast.success(`Template “${name.trim()}” saved`)
      setOpen(false)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save the template',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-label font-medium text-graphite hover:bg-bone hover:text-foreground"
        >
          <LayoutTemplate className="size-3" strokeWidth={1.75} />
          Save as template
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
            <DialogDescription>
              Captures this {entityLabel}
              {entityLabel === 'space'
                ? '’s subtree and glossary — names and skeletons, never content'
                : entityLabel === 'note'
                  ? '’s structure — mentions become plain text'
                  : '’s attribute values — references excluded'}
              . Future edits here never touch what was captured.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Template name</Label>
              <Input
                id="tpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder={
                  entityLabel === 'note'
                    ? 'Call debrief'
                    : entityLabel === 'space'
                      ? 'Market breakdown'
                      : 'Inbound deal defaults'
                }
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending || !name.trim()}>
                {pending ? 'Saving…' : 'Save template'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
