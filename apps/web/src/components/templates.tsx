import { ChevronDown, LayoutTemplate } from 'lucide-react'
import { useState } from 'react'
import type { ReactElement } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
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
 * Template application is manual plus a context hint:
 * the picker is scoped by suggest_on — templates tagged for the surface
 * they're opened from sort first. Ordering, not automation; nothing
 * auto-creates.
 */

export type TemplateRow = Awaited<ReturnType<typeof listTemplates>>[number]

export function TemplatePicker({
  kind,
  objectKind,
  context,
  label = 'From template',
  trigger,
  align = 'end',
  onPick,
}: {
  kind: 'note' | 'space' | 'record' | 'email'
  objectKind?: 'company' | 'person' | 'deal'
  /** Entity kind of the surface this picker sits on — the suggest_on hint. */
  context?: string
  label?: string
  /** Drawn instead of the outline button — a row that opens the picker. It
   *  must be an element that spreads its props (a native `button`). */
  trigger?: ReactElement
  align?: 'start' | 'end'
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
        {trigger ?? (
          <Button size="sm" variant="outline">
            <LayoutTemplate className="size-3.5" strokeWidth={1.75} />
            {label}
            <ChevronDown className="size-3" strokeWidth={2} />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-56">
        {items === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : items.length === 0 ? (
          <DropdownMenuItem disabled>
            No templates yet — save one from an existing{' '}
            {kind === 'record' ? (objectKind ?? 'record') : kind}.
          </DropdownMenuItem>
        ) : (
          items.map((t) => {
            // The kind lane, drawn the way the notes index draws it:
            // quiet, lowercase, and blank for the default. A memo
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
 * - Given `open`, the caller owns the dialog (a menu item opens it) and no
 *   trigger is drawn.
 */
export function SaveAsTemplateAction({
  entityLabel,
  defaultName,
  onSave,
  open: controlled,
  onOpenChange,
}: {
  entityLabel: 'note' | 'space' | 'company' | 'person' | 'deal' | 'email'
  defaultName?: string
  onSave: (name: string) => Promise<void>
  open?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
}) {
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const setOpen = (next: boolean) => {
    setOwn(next)
    onOpenChange?.(next)
  }
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
      {controlled !== undefined ? null : (
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
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
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
                      : entityLabel === 'email'
                        ? 'Founder intro'
                        : 'Inbound deal defaults'
                }
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
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
