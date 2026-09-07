import {
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronRight,
  Circle,
  Compass,
  FileText,
  GitMerge,
  Kanban,
  PenLine,
  Phone,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { optionLabel, refName } from './attributes/value-editor'
import type { RegistryEntry, RefNames } from './attributes/value-editor'
import { cn } from '#/lib/utils'
import type { getRecordTimeline } from '#/lib/server-fns'

/**
 * The activity timeline: an icon lane with a connector thread, macro verbs
 * plus attribute-change bursts ("changed 3 attributes", expandable to
 * attr → new value). The lane is a fixed 24px slot so entries align however
 * their bodies wrap.
 */

type Items = Awaited<ReturnType<typeof getRecordTimeline>>

/**
 * A burst names who attended to the values (typed actor, spec §4): a person
 * by name, an integration, or the system — the merge executor's rewrites
 * must never read as a teammate's edit.
 */
function burstActorLabel(item: {
  actorType: 'user' | 'integration' | 'system'
  actorName: string | null
  source: string
}): string {
  if (item.actorType === 'user') return item.actorName ?? 'Someone'
  if (item.actorType === 'integration') return 'An integration'
  return item.source === 'merge' ? 'A merge' : 'System'
}

const dateTimeFmt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const VERB_LABELS: Record<string, string> = {
  'record.created': 'created this record',
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

const VERB_ICONS: Record<string, typeof Users> = {
  'company.created': Building2,
  'person.created': Users,
  'deal.created': Kanban,
  'note.created': PenLine,
  'document.filed': FileText,
  'space.tagged': Compass,
  'space.untagged': Compass,
  'entity.merged': GitMerge,
  renamed: PenLine,
}

function LaneIcon({
  icon: Icon,
  accent = false,
  last,
}: {
  icon: typeof Users
  accent?: boolean
  last: boolean
}) {
  return (
    <div className="flex w-6 shrink-0 flex-col items-center self-stretch">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full',
          accent ? 'bg-selected' : 'bg-muted',
        )}
      >
        <Icon
          className={cn(
            'size-3',
            accent ? 'text-primary' : 'text-muted-foreground',
          )}
          strokeWidth={2}
        />
      </span>
      {!last ? <span className="mt-1 w-px flex-1 bg-border" /> : null}
    </div>
  )
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
    return <p className="mt-4 text-ui text-muted-foreground">Nothing yet.</p>
  }
  return (
    <ul className="mt-4">
      {items.map((item, i) => {
        const last = i === items.length - 1
        return (
          <li key={item.id} className="flex gap-3">
            {item.type === 'macro' ? (
              <>
                <LaneIcon icon={VERB_ICONS[item.verb] ?? Circle} last={last} />
                <div className={cn('min-w-0 pt-1', !last && 'pb-4')}>
                  <span className="flex items-baseline gap-2 text-ui">
                    <span>
                      <span className="font-medium">
                        {item.actorName ?? 'System'}
                      </span>{' '}
                      {VERB_LABELS[item.verb] ?? item.verb}
                    </span>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      {dateTimeFmt.format(new Date(item.at))}
                    </span>
                  </span>
                </div>
              </>
            ) : item.type === 'interaction' ? (
              <InteractionItem item={item} last={last} />
            ) : (
              <AttrBurst
                item={item}
                registry={registry}
                refNames={refNames}
                last={last}
              />
            )}
          </li>
        )
      })}
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
  last,
}: {
  item: Extract<Items[number], { type: 'interaction' }>
  last: boolean
}) {
  return (
    <>
      <LaneIcon icon={Phone} last={last} />
      <div className={cn('min-w-0 pt-1', !last && 'pb-4')}>
        <span className="flex items-baseline gap-2 text-ui">
          <span className="font-medium capitalize">{item.kind}</span>
          <span className="truncate">{item.subject}</span>
          <span className="tabular shrink-0 text-xs text-muted-foreground">
            {dateTimeFmt.format(new Date(item.at))}
          </span>
        </span>
        {item.attendees.length > 0 ? (
          <span className="mt-1 flex flex-wrap items-center gap-1">
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
        ) : null}
      </div>
    </>
  )
}

function AttrBurst({
  item,
  registry,
  refNames,
  last,
}: {
  item: Extract<Items[number], { type: 'attrs' }>
  registry: Array<RegistryEntry>
  refNames?: RefNames
  last: boolean
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
    <>
      <LaneIcon icon={ArrowRight} accent last={last} />
      <div className={cn('min-w-0 pt-1', !last && 'pb-4')}>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-baseline gap-2 rounded text-left text-ui focus-ring"
        >
          <span className="flex items-center gap-1">
            <span className="font-medium">{burstActorLabel(item)}</span>{' '}
            {item.source === 'merge' ? 'rewrote' : 'changed'}{' '}
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
              {item.changes.length} attribute
              {item.changes.length === 1 ? '' : 's'}
            </span>
            {open ? (
              <ChevronDown className="size-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 text-muted-foreground" />
            )}
          </span>
          <span className="tabular shrink-0 text-xs text-muted-foreground">
            {dateTimeFmt.format(new Date(item.at))}
          </span>
        </button>
        {open ? (
          <dl className="mt-1.5 space-y-1 border-l border-border pl-3">
            {item.changes.map((c, i) => (
              <div key={i} className="flex items-baseline gap-2 text-xs">
                <dt className="w-28 shrink-0 text-muted-foreground">
                  {bySlug.get(c.slug)?.name ?? c.slug}
                </dt>
                <dd className="min-w-0 truncate">
                  {renderValue(c.slug, c.to)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </>
  )
}
