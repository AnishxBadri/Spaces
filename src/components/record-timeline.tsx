import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { optionLabel, refName } from './attributes/value-editor'
import type { RegistryEntry, RefNames } from './attributes/value-editor'
import { cn } from '#/lib/utils'
import type { getRecordTimeline } from '#/lib/server-fns'

/**
 * The record ledger (Instrument, 2026-09-10): one row per entry on a rule —
 * mono time lane, mono type lane, then the body in sans. Macro verbs,
 * interactions, and attribute-change bursts ("changed 3 attributes",
 * expandable to attr → new value) share the same three lanes so the eye
 * reads down a column.
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

/** `MM-DD HH:MM` in the reader's clock — the ledger's time lane. */
function stamp(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

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

const VERB_TYPES: Record<string, string> = {
  'record.created': 'born',
  'company.created': 'born',
  'person.created': 'born',
  'deal.created': 'deal',
  'note.created': 'note',
  'document.filed': 'file',
  'space.tagged': 'space',
  'space.untagged': 'space',
  'entity.merged': 'merge',
  renamed: 'rename',
}

function Row({
  at,
  type,
  children,
  last,
}: {
  at: string
  type: string
  children: React.ReactNode
  last: boolean
}) {
  return (
    <li
      className={cn(
        'flex items-start gap-4 py-2',
        !last && 'border-b border-rule',
      )}
    >
      <span className="w-22 shrink-0 mono text-micro text-graphite">
        {stamp(at)}
      </span>
      <span className="w-18 shrink-0 mono text-micro font-medium text-foreground uppercase">
        {type}
      </span>
      <div className="min-w-0 flex-1 text-ui leading-[1.125rem]">
        {children}
      </div>
    </li>
  )
}

export function RecordTimeline({
  items,
  registry,
  refNames,
}: {
  items: Items
  registry: Array<RegistryEntry>
  refNames?: RefNames | undefined
}) {
  if (items.length === 0) {
    return <p className="py-2 text-label text-graphite">Nothing yet.</p>
  }
  return (
    <ul>
      {items.map((item, i) => {
        const last = i === items.length - 1
        if (item.type === 'macro') {
          return (
            <Row
              key={item.id}
              at={item.at}
              type={VERB_TYPES[item.verb] ?? item.verb.split('.')[0]}
              last={last}
            >
              <span className="font-medium">{item.actorName ?? 'System'}</span>{' '}
              {VERB_LABELS[item.verb] ?? item.verb}
            </Row>
          )
        }
        if (item.type === 'interaction') {
          return (
            <Row key={item.id} at={item.at} type={item.kind} last={last}>
              <span>{item.subject}</span>
              {item.attendees.length > 0 ? (
                <span className="block mono text-micro text-graphite">
                  {item.attendees.map((a) => a.name).join(' · ')}
                </span>
              ) : null}
            </Row>
          )
        }
        return (
          <AttrBurst
            key={item.id}
            item={item}
            registry={registry}
            refNames={refNames}
            last={last}
          />
        )
      })}
    </ul>
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
  refNames?: RefNames | undefined
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

  // A burst that moved the stage is a stage entry; its type lane says so.
  const stage = item.changes.find((c) => c.slug === 'stage')
  const type = stage ? 'stage' : item.source === 'merge' ? 'merge' : 'edit'

  return (
    <Row at={item.at} type={type} last={last}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex items-center gap-1.5 text-left text-ui"
      >
        <span>
          <span className="font-medium">{burstActorLabel(item)}</span>{' '}
          {item.source === 'merge' ? 'rewrote' : 'changed'}{' '}
          {stage ? (
            <>
              stage to{' '}
              <span className="font-medium">
                {renderValue('stage', stage.to)}
              </span>
              {item.changes.length > 1
                ? ` and ${item.changes.length - 1} more`
                : ''}
            </>
          ) : (
            <span className="mono text-micro">
              {item.changes.length} attribute
              {item.changes.length === 1 ? '' : 's'}
            </span>
          )}
        </span>
        {open ? (
          <ChevronDown className="size-3 text-graphite" />
        ) : (
          <ChevronRight className="size-3 text-graphite" />
        )}
      </button>
      {open ? (
        <dl className="mt-1.5 flex flex-col gap-0.5 border-l border-rule pl-3">
          {item.changes.map((c, i) => (
            <div key={i} className="flex items-baseline gap-3">
              <dt className="w-24 shrink-0 truncate label-caps text-[0.625rem] leading-3 font-normal text-graphite">
                {bySlug.get(c.slug)?.name ?? c.slug}
              </dt>
              <dd className="min-w-0 truncate text-label">
                {renderValue(c.slug, c.to)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Row>
  )
}
