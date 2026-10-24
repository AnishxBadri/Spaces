import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  SettingsGroupHead,
  SettingsRowMenu,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
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
 * record, or space), never here. Every change applies at once.
 */
function TemplatesSection({ templates }: { templates: Array<TemplateRow> }) {
  const router = useRouter()
  const live = templates.filter((t) => !t.archived)
  const archived = templates.filter((t) => t.archived)

  async function patch(
    id: string,
    data: { archived?: boolean; suggestOn?: Array<string> },
    ok: string,
  ) {
    try {
      await updateTemplate({ data: { id, ...data } })
      toast.success(ok)
      void router.invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That did not work')
    }
  }

  return (
    <SettingsSection title="Templates" crumb="Workspace">
      <div className="flex flex-col">
        <SettingsGroupHead title="Templates" count={live.length} />
        <div className="flex h-8 items-center gap-3 border-b border-hairline field-label leading-4 text-graphite">
          <span className="min-w-0 flex-1">Template</span>
          <span className="w-32 shrink-0">Kind</span>
          <span className="w-56 shrink-0">Offered first on</span>
          <span className="w-6 shrink-0" />
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
              className="flex h-12 items-center gap-3 border-b border-rule"
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
              <SettingsRowMenu label={t.name}>
                <DropdownMenuItem
                  onSelect={() =>
                    patch(t.id, { archived: true }, `${t.name} archived`)
                  }
                >
                  Archive
                </DropdownMenuItem>
              </SettingsRowMenu>
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
    </SettingsSection>
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
