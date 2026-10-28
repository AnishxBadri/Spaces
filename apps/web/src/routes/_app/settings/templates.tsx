import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsGroupHead,
  SettingsSection,
  rowOpens,
} from '#/components/settings/settings-section'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { MoreMenu } from '#/components/ui/more-menu'
import { updateTemplate } from '#/lib/server-fns'
import type { listTemplates } from '#/lib/server-fns'

const shell = getRouteApi('/_app/settings')

/** Saved patterns for notes, records, space breakdowns and emails. */
export const Route = createFileRoute('/_app/settings/templates')({
  component: TemplatesRoute,
})

function TemplatesRoute() {
  const data = shell.useLoaderData()
  return <TemplatesSection templates={data.templates} />
}

type TemplateRow = Awaited<ReturnType<typeof listTemplates>>[number]

type Offered = { value: string; label: string }

/** Where a template can be offered first, as the chip names it. */
const OFFERED_ON: ReadonlyArray<Offered> = [
  { value: 'company', label: 'Companies' },
  { value: 'person', label: 'People' },
  { value: 'deal', label: 'Deals' },
  { value: 'space', label: 'Spaces' },
]

/** An email template is offered first in the composer: its favourite. */
const OFFERED_IN_EMAIL: ReadonlyArray<Offered> = [
  { value: 'email', label: 'Email' },
]

const offeredFor = (kind: string) =>
  kind === 'email' ? OFFERED_IN_EMAIL : OFFERED_ON

const offeredLabel = (value: string) =>
  [...OFFERED_ON, ...OFFERED_IN_EMAIL].find((o) => o.value === value)?.label ??
  value

const RECORD_KIND: Record<string, string> = {
  company: 'Company record',
  person: 'Person record',
  deal: 'Deal record',
}

/** What the template stamps, as a person says it. */
function templateKindLabel(t: {
  kind: string
  objectKind: string | null
}): string {
  if (t.kind === 'note') return 'Note'
  if (t.kind === 'space') return 'Space breakdown'
  if (t.kind === 'email') return 'Email'
  return RECORD_KIND[t.objectKind ?? ''] ?? 'Record'
}

/**
 * Templates are config, not entities — this is their whole management
 * surface. Creation happens by example ("Save as template" on a note,
 * record, or space), never here. A row click opens its Edit window, for the
 * name; where it is offered first and archiving apply at once from the row.
 */
function TemplatesSection({ templates }: { templates: Array<TemplateRow> }) {
  const router = useRouter()
  const live = templates.filter((t) => !t.archived)
  const archived = templates.filter((t) => t.archived)
  const [editing, setEditing] = useState<TemplateRow | null>(null)

  async function patch(
    id: string,
    data: { archived?: boolean; suggestOn?: Array<string>; name?: string },
    ok: string,
  ): Promise<boolean> {
    try {
      await updateTemplate({ data: { id, ...data } })
      toast.success(ok)
      void router.invalidate()
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That did not work')
      return false
    }
  }

  return (
    <SettingsSection title="Templates" crumb="Workspace">
      <div className="flex flex-col">
        <SettingsGroupHead title="Templates" count={live.length} />
        <div className="flex h-8 items-center gap-3 border-b border-hairline text-label text-graphite">
          <span className="min-w-0 flex-1">Template</span>
          <span className="w-32 shrink-0">Kind</span>
          <span className="w-56 shrink-0">Offered first on</span>
          <span className="w-16 shrink-0" />
        </div>
        {live.length === 0 ? (
          <p className="border-b border-rule py-3 text-label text-graphite">
            No templates.
          </p>
        ) : (
          live.map((t) => (
            <div
              key={t.id}
              data-template-row
              data-row
              onClick={rowOpens(() => setEditing(t))}
              className="flex h-12 cursor-pointer items-center gap-3 border-b border-rule transition-colors duration-150 ease-out-quart hover:bg-bone"
            >
              <span className="min-w-0 flex-1 truncate text-ui font-medium">
                {t.name}
              </span>
              <span className="w-32 shrink-0 truncate text-label text-graphite">
                {templateKindLabel(t)}
              </span>
              <span className="flex w-56 shrink-0 items-center gap-1 overflow-hidden">
                {t.suggestOn.map((k) => (
                  <Badge key={k} option={{ color: 'slate' }} index={0}>
                    {offeredLabel(k)}
                  </Badge>
                ))}
                <OfferedOnMenu
                  template={t}
                  onChange={(suggestOn) =>
                    patch(t.id, { suggestOn }, 'Offered first on updated')
                  }
                />
              </span>
              <span className="flex w-16 shrink-0 justify-end">
                <MoreMenu
                  variant="row"
                  label={t.name}
                  items={[
                    {
                      label: 'Edit…',
                      opens: true,
                      onSelect: () => setEditing(t),
                    },
                    {
                      label: 'Archive',
                      onSelect: () =>
                        void patch(
                          t.id,
                          { archived: true },
                          `${t.name} archived`,
                        ),
                    },
                  ]}
                />
              </span>
            </div>
          ))
        )}
      </div>

      {archived.length > 0 ? (
        <div className="flex flex-col">
          <SettingsGroupHead title="Archived" count={archived.length} />
          {archived.map((t) => (
            <div
              key={t.id}
              data-row
              className="flex h-12 items-center gap-3 border-b border-rule"
            >
              <span className="min-w-0 flex-1 truncate text-ui text-graphite line-through">
                {t.name}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  patch(t.id, { archived: false }, `${t.name} restored`)
                }
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {editing === null ? null : (
        <EditTemplateDialog
          key={editing.id}
          template={editing}
          onClose={() => setEditing(null)}
          onSave={(name) => patch(editing.id, { name }, `${name} saved`)}
        />
      )}
    </SettingsSection>
  )
}

/**
 * Edit (S): the template's name. What it stamps is set by the note, record
 * or space it was saved from, so it is not edited here.
 */
function EditTemplateDialog({
  template,
  onClose,
  onSave,
}: {
  template: TemplateRow
  onClose: () => void
  /** Resolves true once the name is stored. */
  onSave: (name: string) => Promise<boolean>
}) {
  const [name, setName] = useState(template.name)
  const [pending, setPending] = useState(false)
  const trimmed = name.trim()

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (trimmed === '' || trimmed === template.name) {
      onClose()
      return
    }
    setPending(true)
    const saved = await onSave(trimmed)
    setPending(false)
    if (saved) onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Edit template</DialogTitle>
          <span className="mono text-micro text-graphite">
            {templateKindLabel(template)}
          </span>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="template-name">Name</Label>
            <Input
              id="template-name"
              autoFocus
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || trimmed === ''}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The dashed `+`: tick where the template is offered first. */
function OfferedOnMenu({
  template,
  onChange,
}: {
  template: TemplateRow
  onChange: (suggestOn: Array<string>) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge
          asChild
          option={undefined}
          index={0}
          unselected
          className="justify-center px-1"
        >
          <button
            type="button"
            aria-label={`Where ${template.name} is offered first`}
          >
            +
          </button>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        {offeredFor(template.kind).map((o) => {
          const on = template.suggestOn.includes(o.value)
          return (
            <DropdownMenuCheckboxItem
              key={o.value}
              checked={on}
              onCheckedChange={(next) =>
                onChange(
                  next
                    ? [...template.suggestOn, o.value]
                    : template.suggestOn.filter((k) => k !== o.value),
                )
              }
            >
              {o.label}
            </DropdownMenuCheckboxItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
