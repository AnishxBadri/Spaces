import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import {
  ArrowLeft,
  Building2,
  FileText,
  Globe,
  Layers,
  Plus,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import {
  addCompanyDomain,
  createNote,
  getCompany,
  listSpaces,
  tagIntoSpace,
  untagFromSpace,
  updateCompany,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/companies_/$companyId')({
  loader: async ({ params }) => {
    const [companyData, spaces] = await Promise.all([
      getCompany({ data: { id: params.companyId } }),
      listSpaces(),
    ])
    // Merged-away records redirect to their survivor — stale URLs keep working.
    if (companyData.mergedIntoId) {
      throw redirect({
        to: '/companies/$companyId',
        params: { companyId: companyData.mergedIntoId },
      })
    }
    return { company: companyData, allSpaces: spaces }
  },
  component: CompanyRecordPage,
})

const dateTimeFmt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const VERB_LABELS: Record<string, string> = {
  'company.created': 'Company created',
  'company.updated': 'Attributes updated',
  'space.tagged': 'Tagged into space',
  'space.untagged': 'Removed from space',
  'note.created': 'Note created',
}

function CompanyRecordPage() {
  const { company, allSpaces } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'activity' | 'notes'>('activity')

  const noteMentions = company.mentionedIn.filter((m) => m.kind === 'note')
  const domains = company.aliases.filter((a) => a.kind === 'domain')
  const nameAliases = company.aliases.filter(
    (a) => a.kind === 'name' && a.value !== company.name,
  )
  const untaggedSpaces = allSpaces.filter(
    (s) => !company.spaces.some((cs) => cs.id === s.id),
  )

  async function newNoteAboutThis() {
    const { id } = await createNote({
      data: {
        about: { entityId: company.id, label: company.name, kind: 'company' },
      },
    })
    navigate({ to: '/notes/$noteId', params: { noteId: id } })
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 md:px-10">
      <Link
        to="/companies"
        className="flex w-fit items-center gap-1.5 rounded-md text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        Companies
      </Link>

      <header className="mt-5 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-muted">
          <Building2 className="size-4.5 text-muted-foreground" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-semibold tracking-tight">
            {company.name}
          </h1>
          {nameAliases.length > 0 ? (
            <p className="truncate text-xs text-muted-foreground">
              also seen as {nameAliases.map((a) => a.value).join(', ')}
            </p>
          ) : null}
        </div>
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)_220px]">
        {/* Left: attributes */}
        <aside className="space-y-5">
          <AttrField
            label="Stage"
            value={company.attrs.stage ?? ''}
            placeholder="Seed"
            onSave={(v) =>
              save({ id: company.id, stage: v || null }, router)
            }
          />
          <AttrField
            label="Geography"
            value={company.attrs.geo ?? ''}
            placeholder="Bengaluru"
            onSave={(v) => save({ id: company.id, geo: v || null }, router)}
          />
          <AttrField
            label="Founded"
            value={company.attrs.foundedYear?.toString() ?? ''}
            placeholder="2021"
            onSave={(v) =>
              save(
                { id: company.id, foundedYear: v ? Number(v) : null },
                router,
              )
            }
          />
          <AttrField
            label="Sectors"
            value={company.attrs.sectors.join(', ')}
            placeholder="robotics, defence"
            onSave={(v) =>
              save(
                {
                  id: company.id,
                  sectors: v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
                router,
              )
            }
          />

          <DomainsField companyId={company.id} domains={domains} />
        </aside>

        {/* Center: tabs */}
        <section className="min-w-0">
          <div className="flex items-center justify-between border-b border-border">
            <div role="tablist" className="flex gap-1">
              {(['activity', 'notes'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'relative px-3 pb-2.5 text-[13px] font-medium capitalize text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-t-md',
                    tab === t &&
                      'text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === 'notes' ? (
              <Button size="xs" variant="outline" onClick={newNoteAboutThis}>
                <Plus className="size-3" strokeWidth={2} />
                Note about this
              </Button>
            ) : null}
          </div>

          {tab === 'activity' ? (
            <ul className="mt-4 space-y-2.5">
              {company.timeline.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  Nothing yet.
                </p>
              ) : (
                company.timeline.map((t) => (
                  <li key={t.id} className="flex items-baseline gap-3 text-[13px]">
                    <span className="tabular w-28 shrink-0 text-xs text-muted-foreground/80">
                      {dateTimeFmt.format(new Date(t.at))}
                    </span>
                    <span>{VERB_LABELS[t.verb] ?? t.verb}</span>
                  </li>
                ))
              )}
            </ul>
          ) : (
            <ul className="mt-4 space-y-1">
              {noteMentions.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  No notes mention {company.name} yet. Write one — it links
                  itself here.
                </p>
              ) : (
                noteMentions.map((m) => (
                  <li key={m.fromId}>
                    <Link
                      to="/notes/$noteId"
                      params={{ noteId: m.fromId }}
                      className="flex h-9 items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <FileText
                        className="size-4 text-muted-foreground"
                        strokeWidth={1.75}
                      />
                      <span className="font-medium">{m.name}</span>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          )}
        </section>

        {/* Right: related */}
        <aside className="space-y-6">
          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Spaces
            </h2>
            <ul className="mt-2 space-y-1">
              {company.spaces.map((s) => (
                <li
                  key={s.id}
                  className="group flex h-7 items-center gap-2 rounded-md px-1.5 text-[13px] hover:bg-accent"
                >
                  <Layers
                    className="size-3.5 shrink-0 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <button
                    aria-label={`Remove from ${s.name}`}
                    onClick={async () => {
                      await untagFromSpace({
                        data: { entityId: company.id, spaceId: s.id },
                      })
                      router.invalidate()
                    }}
                    className="hidden size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground group-hover:flex focus-visible:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
            {untaggedSpaces.length > 0 ? (
              <select
                aria-label="Tag into space"
                value=""
                onChange={async (e) => {
                  if (!e.target.value) return
                  await tagIntoSpace({
                    data: { entityId: company.id, spaceId: e.target.value },
                  })
                  router.invalidate()
                }}
                className="border-input mt-2 h-7 w-full rounded-md border bg-transparent px-2 text-xs text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">+ Tag into space…</option>
                {untaggedSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {' '.repeat(s.depth * 2)}
                    {s.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Mentioned in
            </h2>
            {company.mentionedIn.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground/80">
                Nowhere yet.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {company.mentionedIn.map((m) => (
                  <li key={m.fromId} className="truncate text-[13px]">
                    {m.kind === 'note' ? (
                      <Link
                        to="/notes/$noteId"
                        params={{ noteId: m.fromId }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {m.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{m.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

async function save(
  data: Parameters<typeof updateCompany>[0] extends { data: infer D }
    ? D
    : never,
  router: ReturnType<typeof useRouter>,
) {
  try {
    await updateCompany({ data })
    router.invalidate()
  } catch {
    toast.error('Could not save')
  }
}

function AttrField({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string
  value: string
  placeholder: string
  onSave: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const id = `attr-${label.toLowerCase()}`
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onSave(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="h-8 text-[13px]"
      />
    </div>
  )
}

function DomainsField({
  companyId,
  domains,
}: {
  companyId: string
  domains: Array<{ id: string; valueNorm: string }>
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  async function add() {
    const domain = draft.trim()
    if (!domain) return setAdding(false)
    try {
      const result = await addCompanyDomain({
        data: { id: companyId, domain },
      })
      if (result.outcome === 'suggested_duplicate') {
        toast(`Another company already owns ${domain}`, {
          description:
            'Flagged as a possible duplicate — review it in the dedupe inbox.',
        })
      } else if (result.outcome === 'already_own') {
        toast(`${domain} is already on this company`)
      }
      setDraft('')
      setAdding(false)
      router.invalidate()
    } catch {
      toast.error('Not a valid domain')
    }
  }

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">Domains</span>
      <ul className="space-y-1">
        {domains.map((d) => (
          <li
            key={d.id}
            className="flex h-7 items-center gap-2 text-[13px]"
          >
            <Globe className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
            {d.valueNorm}
          </li>
        ))}
      </ul>
      {adding ? (
        <Input
          autoFocus
          value={draft}
          placeholder="acme.com"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          className="h-7 text-xs"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Plus className="size-3" strokeWidth={2} />
          Add domain
        </button>
      )}
    </div>
  )
}
