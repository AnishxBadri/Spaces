import { Building2, ChevronDown, ChevronRight, Kanban, Phone, Users } from 'lucide-react'
import { useState } from 'react'
import { optionLabel } from './attributes/value-editor'
import type { RegistryEntry, RefNames } from './attributes/value-editor'
import { refName } from './attributes/value-editor'
import type { getRecordTimeline } from '#/lib/server-fns'

/**
 * The condensed activity timeline: macro verbs plus attribute-change
 * bursts ("changed 3 attributes", expandable to attr → new value).
 */

type Items = Awaited<ReturnType<typeof getRecordTimeline>>

const dateTimeFmt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const VERB_LABELS: Record<string, string> = {
  'company.created': 'created this company',
  'person.created': 'created this person',
  'deal.created': 'created a deal',
  'note.created': 'wrote a note',
  'document.filed': 'filed a document',
  'space.tagged': 'tagged into a space',
  'space.untagged': 'removed from a space',
  'entity.merged': 'merged a duplicate record',
  renamed: 'renamed this record',
}

export function RecordTimeline({
  items,
  registry,
  refNames,
}: {
  items: Items
  registry: Array<RegistryEntry>
  refNames?: RefNames
}) {
  if (items.length === 0) {
    return <p className="mt-4 text-[13px] text-muted-foreground">Nothing yet.</p>
  }
  return (
    <ul className="mt-4 space-y-1">
      {items.map((item) => (
        <li key={item.id}>
          {item.type === 'macro' ? (
            <div className="flex items-baseline gap-3 px-1 py-1 text-[13px]">
              <span className="tabular w-28 shrink-0 text-xs text-muted-foreground/80">
                {dateTimeFmt.format(new Date(item.at))}
              </span>
              <span>
                <span className="font-medium">{item.actorName ?? 'System'}</span>{' '}
                {VERB_LABELS[item.verb] ?? item.verb}
              </span>
            </div>
          ) : item.type === 'interaction' ? (
            <InteractionItem item={item} />
          ) : (
            <AttrBurst item={item} registry={registry} refNames={refNames} />
          )}
        </li>
      ))}
    </ul>
  )
}

const ATTENDEE_ICONS: Record<string, typeof Users> = {
  person: Users,
  company: Building2,
  deal: Kanban,
}

function InteractionItem({
  item,
}: {
  item: Extract<Items[number], { type: 'interaction' }>
}) {
  return (
    <div className="flex items-baseline gap-3 rounded-md bg-muted/40 px-1 py-1.5 text-[13px]">
      <span className="tabular w-28 shrink-0 text-xs text-muted-foreground/80">
        {dateTimeFmt.format(new Date(item.at))}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Phone className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="font-medium capitalize">{item.kind}</span>
        <span className="truncate">— {item.subject}</span>
        {item.attendees.map((a) => {
          const Icon = ATTENDEE_ICONS[a.kind] ?? Users
          return (
            <span
              key={a.id}
              className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium"
            >
              <Icon className="size-2.5" strokeWidth={1.75} />
              {a.name}
            </span>
          )
        })}
      </span>
    </div>
  )
}

function AttrBurst({
  item,
  registry,
  refNames,
}: {
  item: Extract<Items[number], { type: 'attrs' }>
  registry: Array<RegistryEntry>
  refNames?: RefNames
}) {
  const [open, setOpen] = useState(false)
  const bySlug = new Map(registry.map((d) => [d.slug, d]))

  function renderValue(slug: string, to: unknown): string {
    if (to == null) return '—'
    const def = bySlug.get(slug)
    if (!def) return String(to)
    if (def.type === 'select' || def.type === 'status')
      return optionLabel(def, to)
    if (def.type === 'multi_select' && Array.isArray(to))
      return to.map((v) => optionLabel(def, v)).join(', ')
    if (def.type === 'record_reference' || def.type === 'actor_reference') {
      const ids = Array.isArray(to) ? to : [to]
      return ids.map((id) => refName(refNames, String(id))).join(', ')
    }
    return String(to)
  }

  return (
    <div className="rounded-md px-1 py-1 text-[13px]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="tabular w-28 shrink-0 text-xs text-muted-foreground/80">
          {dateTimeFmt.format(new Date(item.at))}
        </span>
        <span className="flex items-center gap-1">
          <span className="font-medium">{item.actorName ?? 'System'}</span>{' '}
          changed{' '}
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
            {item.changes.length} attribute{item.changes.length === 1 ? '' : 's'}
          </span>
          {open ? (
            <ChevronDown className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 text-muted-foreground" />
          )}
        </span>
      </button>
      {open ? (
        <dl className="mt-1.5 ml-31 space-y-1 border-l border-border pl-3">
          {item.changes.map((c, i) => (
            <div key={i} className="flex items-baseline gap-2 text-xs">
              <dt className="w-28 shrink-0 text-muted-foreground">
                {bySlug.get(c.slug)?.name ?? c.slug}
              </dt>
              <dd className="min-w-0 truncate">{renderValue(c.slug, c.to)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
