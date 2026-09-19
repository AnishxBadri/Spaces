import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { SettingsSection } from '#/components/settings/settings-section'
import { updateTemplate } from '#/lib/server-fns'
import type { listTemplates } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

const shell = getRouteApi('/_app/settings')

/** Saved patterns for notes, records and space breakdowns. */
export const Route = createFileRoute('/_app/settings/templates')({
  component: TemplatesRoute,
})

function TemplatesRoute() {
  const data = shell.useLoaderData()
  return <TemplatesSection templates={data.templates} />
}

type TemplateRow = Awaited<ReturnType<typeof listTemplates>>[number]

const SUGGEST_KINDS = ['company', 'person', 'deal', 'space'] as const

/**
 * Templates are config, not entities — this is their whole management
 * surface. Creation happens by example ("Save as template" on a note,
 * record, or space), never here.
 */
function TemplatesSection({ templates }: { templates: Array<TemplateRow> }) {
  const router = useRouter()

  async function patch(
    id: string,
    data: { name?: string; archived?: boolean; suggestOn?: Array<string> },
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
    <SettingsSection
      title="Templates"
      blurb="Saved patterns for notes, records, and space breakdowns. Create one from any existing note, record, or space — “Save as template”."
      crumb="Workspace"
    >
      {templates.length === 0 ? (
        <p className="border-b border-rule py-3 text-label text-graphite">
          None yet. Open a note, record, or space you like the shape of and save
          it as the pattern.
        </p>
      ) : (
        <ul className="flex flex-col">
          {templates.map((t) => (
            <li
              key={t.id}
              className={cn(
                'flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule py-2',
                t.archived && 'text-graphite',
              )}
            >
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-ui font-medium',
                    t.archived && 'line-through',
                  )}
                >
                  {t.name}
                </span>
                <span className="block mono text-micro text-graphite">
                  {t.kind === 'record' ? (t.objectKind ?? 'record') : t.kind}
                </span>
              </span>
              <span className="flex items-center gap-1">
                {SUGGEST_KINDS.map((k) => {
                  const on = t.suggestOn.includes(k)
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      title={`Suggest first on ${k} surfaces`}
                      onClick={() =>
                        patch(
                          t.id,
                          {
                            suggestOn: on
                              ? t.suggestOn.filter((x) => x !== k)
                              : [...t.suggestOn, k],
                          },
                          'Suggestion contexts updated',
                        )
                      }
                      className={cn(
                        'focus-ring h-6 border px-2 mono text-micro',
                        on
                          ? 'border-hairline bg-paper text-foreground'
                          : 'border-rule text-graphite hover:border-hairline hover:text-foreground',
                      )}
                    >
                      {k}
                    </button>
                  )
                })}
              </span>
              <button
                type="button"
                onClick={() =>
                  patch(
                    t.id,
                    { archived: !t.archived },
                    t.archived ? 'Template restored' : 'Template archived',
                  )
                }
                className="focus-ring mono text-micro text-graphite hover:text-foreground"
              >
                {t.archived ? 'restore' : 'archive'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  )
}
