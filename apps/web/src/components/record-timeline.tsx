import { useRouter, useSearch } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Mail } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { optionLabel, refName } from './attributes/value-editor'
import { EmailModal } from './email-dialog'
import { badgeClasses } from './ui/badge'
import { MoreMenu } from './ui/more-menu'
import { KIND_GLYPHS, ThreadSubject } from './record/thread-row'
import type { RegistryEntry, RefNames } from './attributes/value-editor'
import { FilterCount, FilterRow, FilterTab } from './filter-row'
import { fmtMoney } from '@spaces/core/portfolio/format'
import {
  getRecordEmailVisibility,
  setRecordEmailVisibility,
  writeUpInteraction,
} from '#/lib/server-fns'
import { formatDay, formatWhen } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import {
  INTERACTION_FILTERS,
  inInteractionFilter,
  interactionCounts,
} from '#/lib/timeline/interaction-filter'
import type { InteractionFilter } from '#/lib/timeline/interaction-filter'
import { openModalId } from '#/lib/modal-search'
import { threadPeople } from '#/lib/timeline/threads'
import { cn } from '#/lib/utils'
import type { getRecordTimeline } from '#/lib/server-fns'

/**
 * The record ledger: one row per entry on a rule —
 * mono time lane, mono type lane, then the body in sans. Macro verbs,
 * interactions, and attribute-change bursts ("changed 3 attributes",
 * expandable to attr → new value) share the same three lanes so the eye
 * reads down a column.
 */

type Items = Awaited<ReturnType<typeof getRecordTimeline>>

/**
 * A burst names who attended to the values (the typed actor): a person by
 * name, an integration by its plugin's name, or the system. The merge
 * executor's rewrites must never read as a teammate's edit, and two
 * integrations must never read as one.
 * - `integrationName` is `attribute_event.actor_ref` → `integration`: the
 *   manifest's `name`, else the capability id ("Apollo", not "a plugin").
 * - The fallback is unreachable while the check constraint and the FK
 *   hold; it exists because a label has to render either way.
 */
function burstActorLabel(item: {
  actorType: 'user' | 'integration' | 'system'
  actorName: string | null
  integrationName: string | null
  source: string
}): string {
  if (item.actorType === 'user') return item.actorName ?? 'Someone'
  if (item.actorType === 'integration')
    return item.integrationName ?? 'Unnamed integration'
  return item.source === 'merge' ? 'A merge' : 'System'
}

/**
 * Exported so a producer's new verb can be pinned to a label by a test
 * rather than discovered as a raw `note.kind_changed` in the timeline.
 */
export const VERB_LABELS: Record<string, string> = {
  'record.created': 'created this record',
  'company.created': 'created this company',
  'person.created': 'created this person',
  'deal.created': 'created a deal',
  'note.created': 'wrote a note',
  'note.kind_changed': 'changed a note’s kind',
  'note.filed': 'filed a note against this record',
  'note.unfiled': 'unfiled a note from this record',
  'document.filed': 'filed a document',
  'document.refiled': 'changed a document’s filing',
  'document.arrived': 'filed a document again',
  'document.kind_changed': 'changed a document’s kind',
  'document.reextract_requested': 'asked for a document to be read again',
  'space.tagged': 'tagged into a space',
  'space.untagged': 'removed from a space',
  'entity.merged': 'merged a duplicate record',
  renamed: 'renamed this record',
  'space.created': 'created this space',
  'term.created': 'defined a term',
  'mandate.created': 'wrote the mandate',
  // A plugin's `Content.emitSignal`; the actor is the integration, named
  // from `meta.integrationId`.
  'signal.emitted': 'reported a signal',
  // One enrichment run on the record, whichever sources answered.
  'entity.enriched': 'enriched this record',
  // The portfolio ledger's verbs. A producer's verb is pinned here by a
  // test, so none reads raw as `mark.added`.
  'holding.created': 'opened this holding',
  'holding.writtenoff': 'wrote off this holding',
  'investment.added': 'recorded a check',
  'investment.voided': 'voided a check',
  'investment.batch_voided': 'voided a batch of checks',
  'round.added': 'added a round',
  'mark.added': 'recorded a mark',
  'mark.voided': 'voided a mark',
  'mark.batch_voided': 'voided a batch of marks',
  'distribution.added': 'recorded a distribution',
  'distribution.voided': 'voided a distribution',
  'distribution.batch_voided': 'voided a batch of distributions',
}

export const VERB_TYPES: Record<string, string> = {
  'record.created': 'born',
  'company.created': 'born',
  'person.created': 'born',
  'deal.created': 'deal',
  'note.created': 'note',
  'note.kind_changed': 'note',
  'note.filed': 'note',
  'note.unfiled': 'note',
  'document.filed': 'file',
  'document.refiled': 'file',
  'document.arrived': 'file',
  'document.kind_changed': 'file',
  'document.reextract_requested': 'file',
  'space.tagged': 'space',
  'space.untagged': 'space',
  'entity.merged': 'merge',
  renamed: 'rename',
  'space.created': 'born',
  'term.created': 'term',
  'mandate.created': 'mandate',
  'signal.emitted': 'signal',
  'entity.enriched': 'enrich',
  'holding.created': 'holding',
  'holding.writtenoff': 'writeoff',
  'investment.added': 'invest',
  'investment.voided': 'void',
  'investment.batch_voided': 'void',
  'round.added': 'round',
  'mark.added': 'mark',
  'mark.voided': 'void',
  'mark.batch_voided': 'void',
  'distribution.added': 'distrib',
  'distribution.voided': 'void',
  'distribution.batch_voided': 'void',
}

/** How much history a record shows before the fold. */
export const HISTORY_FOLD = 6

/** How many interactions a record shows before the fold. */
export const INTERACTIONS_FOLD = 20

type Item = Items[number]
type InteractionItem = Extract<Item, { type: 'interaction' }>
type LedgerItem = Extract<Item, { type: 'ledger' }>

/**
 * A record's ledger split into its two tabs: the conversations, and the
 * bookkeeping (stage moves, attribute bursts, filings, the portfolio's
 * verbs). One flat list gave a call the weight of `tagged into a space`.
 */
export function splitLedger(items: Items): {
  interactions: Array<InteractionItem>
  history: Items
} {
  return {
    interactions: items.filter(
      (i): i is InteractionItem => i.type === 'interaction',
    ),
    history: items.filter((i) => i.type !== 'interaction'),
  }
}

const INTERACTION_FILTER_LABELS: Record<InteractionFilter, string> = {
  all: 'All',
  email: 'Email',
  meeting: 'Meeting',
  call: 'Call',
  attachments: 'Has attachments',
}

/** The History tab's filters on a deal. */
export const HISTORY_FILTERS = ['all', 'stage', 'attributes', 'ledger'] as const
export type HistoryFilter = (typeof HISTORY_FILTERS)[number]

const HISTORY_FILTER_LABELS: Record<HistoryFilter, string> = {
  all: 'All',
  stage: 'Stage',
  attributes: 'Attributes',
  ledger: 'Ledger',
}

/** The portfolio's verbs: a check, a mark, a distribution, a round, a holding. */
const LEDGER_VERB = /^(investment|mark|distribution|round|holding)\./

/** Which History filter an entry belongs to besides All; null for none. */
export function historyKind(item: Item): Exclude<HistoryFilter, 'all'> | null {
  if (item.type === 'ledger') return 'ledger'
  if (item.type === 'attrs')
    return item.changes.some((c) => c.slug === 'stage') ? 'stage' : 'attributes'
  if (item.type === 'macro' && LEDGER_VERB.test(item.verb)) return 'ledger'
  return null
}

/** How many entries each History filter lists. */
export function historyCounts(history: Items): Record<HistoryFilter, number> {
  const of = (k: HistoryFilter) =>
    history.filter((i) => historyKind(i) === k).length
  return {
    all: history.length,
    stage: of('stage'),
    attributes: of('attributes'),
    ledger: of('ledger'),
  }
}

/** `20 of 34 · more ›` — the foot of a list folded at its cap. */
function FoldFoot({
  shown,
  total,
  onMore,
}: {
  shown: number
  total: number
  onMore: () => void
}) {
  return (
    <button
      type="button"
      onClick={onMore}
      className="focus-ring-inset flex h-ledger-row w-full items-center gap-3 px-3 text-left mono text-micro text-graphite hover:text-foreground"
    >
      {shown} of {total} · more ›
    </button>
  )
}

/**
 * The head's `···` for a viewer with private emails here: their emails with
 * this record, opened to the workspace or not (the record override). Its one
 * item draws as a switch, absent until the state has been read.
 */
function EmailVisibilityMenu({ recordId }: { recordId: string }) {
  const router = useRouter()
  const [workspace, setWorkspace] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    void getRecordEmailVisibility({ data: { entityId: recordId } })
      .then((v) => {
        if (live) setWorkspace(v.workspace)
      })
      .catch(() => {
        if (live) setWorkspace(null)
      })
    return () => {
      live = false
    }
  }, [recordId])

  async function toggle(next: boolean) {
    setWorkspace(next)
    try {
      await setRecordEmailVisibility({
        data: { entityId: recordId, workspace: next },
      })
      void router.invalidate()
    } catch (err) {
      setWorkspace(!next)
      toast(err instanceof Error ? err.message : 'Could not save who sees it')
    }
  }

  return (
    <MoreMenu
      variant="head"
      label="interactions"
      items={[
        {
          label: 'My emails visible to the workspace',
          checked: workspace === true,
          disabled: workspace === null,
          onCheckedChange: (next) => void toggle(next),
        },
      ]}
    />
  )
}

/**
 * The Interactions tab: the kind filters, the composer row, then calls, emails and meetings, folded past
 * `INTERACTIONS_FOLD`. The filter is the view's own state, as the space
 * page's Notes filter is, unless the page holds it for the tab head's count.
 * - `recordId` lets the email window widen for this record, and puts the
 *   override in the head's `···` once the viewer has private emails here.
 * - The email `?modal=email&id=` opens stays highlighted behind its window,
 *   unfolded to when it sits past the fold.
 */
export function RecordInteractions({
  items,
  registry,
  refNames,
  composer,
  recordId,
  filter: held,
  onFilterChange,
}: {
  items: Items
  registry: Array<RegistryEntry>
  refNames?: RefNames | undefined
  /** The composer row — a `LogInteractionDialog` trigger. */
  composer?: React.ReactNode
  /** The record the tab is on. */
  recordId?: string
  /** The filter, when the page holds it. */
  filter?: InteractionFilter
  onFilterChange?: (filter: InteractionFilter) => void
}) {
  const { interactions } = splitLedger(items)
  const [own, setOwn] = useState<InteractionFilter>('all')
  const filter = held ?? own
  const setFilter = (next: InteractionFilter) => {
    setOwn(next)
    onFilterChange?.(next)
  }
  const [unfolded, setUnfolded] = useState(false)
  const opened = openModalId(useSearch({ strict: false }), 'email')
  const counts = interactionCounts(interactions)
  const listed = interactions.filter((i) => inInteractionFilter(i, filter))
  const openedAt = listed.findIndex((i) => i.id === opened)
  const shown =
    unfolded || openedAt >= INTERACTIONS_FOLD
      ? listed
      : listed.slice(0, INTERACTIONS_FOLD)
  return (
    <div className="flex flex-col">
      <FilterRow
        label="Show interactions"
        end={
          recordId !== undefined &&
          interactions.some((i) => i.kind === 'email' && i.ownPrivate) ? (
            <EmailVisibilityMenu recordId={recordId} />
          ) : undefined
        }
      >
        {INTERACTION_FILTERS.map((f) => (
          <FilterTab key={f} active={filter === f} onClick={() => setFilter(f)}>
            {INTERACTION_FILTER_LABELS[f]} <FilterCount n={counts[f]} />
          </FilterTab>
        ))}
      </FilterRow>
      {composer}
      <RecordTimeline
        items={shown}
        registry={registry}
        refNames={refNames}
        empty={composer ? null : 'None logged.'}
        last={shown.length === listed.length}
        highlight={opened}
      />
      {shown.length < listed.length ? (
        <FoldFoot
          shown={shown.length}
          total={listed.length}
          onMore={() => setUnfolded(true)}
        />
      ) : null}
      <EmailModal recordId={recordId ?? null} />
    </div>
  )
}

/**
 * The History tab, folded past `HISTORY_FOLD` so the surface is bounded.
 * `filters` draws All · Stage ·
 * Attributes · Ledger over it (a deal's).
 */
export function RecordHistory({
  items,
  registry,
  refNames,
  filters = false,
}: {
  items: Items
  registry: Array<RegistryEntry>
  refNames?: RefNames | undefined
  filters?: boolean
}) {
  const { history } = splitLedger(items)
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [unfolded, setUnfolded] = useState(false)
  const listed =
    filter === 'all'
      ? history
      : history.filter((i) => historyKind(i) === filter)
  const shown =
    unfolded || listed.length <= HISTORY_FOLD
      ? listed
      : listed.slice(0, HISTORY_FOLD)
  const counts = historyCounts(history)
  return (
    <div className="flex flex-col">
      {filters ? (
        <FilterRow label="Show history">
          {HISTORY_FILTERS.map((f) => (
            <FilterTab
              key={f}
              active={filter === f}
              onClick={() => setFilter(f)}
            >
              {HISTORY_FILTER_LABELS[f]} <FilterCount n={counts[f]} />
            </FilterTab>
          ))}
        </FilterRow>
      ) : null}
      <RecordTimeline
        items={shown}
        registry={registry}
        refNames={refNames}
        last={shown.length === listed.length}
      />
      {shown.length < listed.length ? (
        <FoldFoot
          shown={shown.length}
          total={listed.length}
          onMore={() => setUnfolded(true)}
        />
      ) : null}
    </div>
  )
}

function Row({
  at,
  type,
  children,
  end,
  last,
}: {
  at: string
  type: string
  children: React.ReactNode
  /** The fixed mono lane the row ends on. */
  end?: React.ReactNode
  last: boolean
}) {
  const { now } = useClock()
  return (
    <li
      className={cn(
        'group/row flex items-start gap-4 px-3 py-2',
        !last && 'border-b border-rule',
      )}
    >
      <span className="w-22 shrink-0 mono text-micro text-graphite">
        {formatWhen(at, now)}
      </span>
      <span className="w-18 shrink-0 mono text-micro font-medium text-foreground uppercase">
        {type}
      </span>
      <div className="min-w-0 flex-1 text-ui leading-4.5">{children}</div>
      {end === undefined ? null : (
        <span
          data-end-lane
          className="flex w-48 shrink-0 items-center justify-end gap-2 mono text-micro text-graphite"
        >
          {end}
        </span>
      )}
    </li>
  )
}

export function RecordTimeline({
  items,
  registry,
  refNames,
  empty = 'Nothing yet.',
  last: lastRow = true,
  highlight = null,
}: {
  items: Items
  registry: Array<RegistryEntry>
  refNames?: RefNames | undefined
  /** The line an empty list shows; `null` shows nothing (a composer row is already there). */
  empty?: string | null
  /** False when a fold row follows, so the last entry keeps its rule. */
  last?: boolean
  /** The interaction whose window is open over the list. */
  highlight?: string | null
}) {
  if (items.length === 0) {
    return empty === null ? null : (
      <p className="px-3 py-2 text-label text-graphite">{empty}</p>
    )
  }
  return (
    <ul>
      {items.map((item, i) => {
        const last = lastRow && i === items.length - 1
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
            <InteractionRow
              key={item.id}
              item={item}
              last={last}
              highlighted={item.id === highlight}
            />
          )
        }
        if (item.type === 'ledger') {
          return <LedgerEntry key={item.id} item={item} last={last} />
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

/** The end lane of an interaction: `via Anish · ⧉ 2 · accepted`. */
export function interactionLane(item: {
  via: string | null
  attachments: number
  answer: string | null
}): string {
  return [
    item.via === null ? null : `via ${item.via}`,
    item.attachments > 0 ? `⧉ ${item.attachments}` : null,
    item.answer,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** The line under an email's subject: its summary, else the snippet, unmarked. */
export function interactionLine(item: {
  summary: string | null
  snippet: string | null
}): { text: string; from: 'summary' | 'snippet' } | null {
  if (item.summary !== null) return { text: item.summary, from: 'summary' }
  if (item.snippet !== null) return { text: item.snippet, from: 'snippet' }
  return null
}

/**
 * One interaction on the ledger: kind glyph, subject in ink
 * and participants in graphite, the summary clamped at two lines with the
 * snippet as its unmarked fallback and the category chips, then the mono end
 * lane — `via`, attachments, the answer and the date.
 * - An email opens its window from the subject (`?modal=email&id=`);
 *   any other written-up row opens its note; one that is not offers
 *   `Write up` as a row action, shown on hover and focus.
 * - A body private to someone else keeps its subject and says
 *   `body private`; its summary, snippet and chips are never sent.
 */
function InteractionRow({
  item,
  last,
  highlighted,
}: {
  item: InteractionItem
  last: boolean
  highlighted: boolean
}) {
  const router = useRouter()
  const { now } = useClock()
  const [pending, setPending] = useState(false)

  async function writeUp() {
    setPending(true)
    try {
      const { noteId } = await writeUpInteraction({
        data: { interactionId: item.id },
      })
      void router.invalidate()
      await router.navigate({ to: '/notes/$noteId', params: { noteId } })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not write it up')
      setPending(false)
    }
  }

  const Glyph = KIND_GLYPHS[item.kind] ?? Mail
  const people = threadPeople(item)
  const line = interactionLine(item)
  const lane = item.privateBody
    ? ['body private', interactionLane(item)]
        .filter((part) => part !== '')
        .join(' · ')
    : interactionLane(item)

  return (
    <li
      data-highlighted={highlighted ? '' : undefined}
      className={cn(
        'group/row flex min-h-ledger-row items-start gap-3 px-3 py-2.5',
        !last && 'border-b border-rule',
        highlighted && 'bg-bone',
      )}
    >
      <Glyph
        role="img"
        aria-label={item.kind}
        className="mt-0.75 size-3.5 shrink-0 text-graphite"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <ThreadSubject item={item} />
          {people === '' ? null : (
            <span
              data-participants
              className="min-w-0 flex-1 truncate text-label text-graphite"
            >
              {people}
            </span>
          )}
          {item.categories.length > 0 ? (
            <span className="ml-auto flex shrink-0 gap-1">
              {item.categories.map((c) => (
                <span
                  key={c}
                  data-category
                  className={badgeClasses({
                    className: 'bg-bone text-graphite',
                  })}
                >
                  {c}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        {line === null ? null : (
          <p
            data-line={line.from}
            className="mt-0.5 line-clamp-2 text-label text-foreground"
          >
            {line.text}
          </p>
        )}
      </div>
      <span
        data-end-lane
        className="flex w-60 shrink-0 items-center justify-end gap-2 mono text-micro leading-5 text-graphite"
      >
        {item.noteId || item.privateBody ? null : (
          <button
            type="button"
            onClick={() => void writeUp()}
            disabled={pending}
            className={cn(
              'focus-ring shrink-0 font-sans text-label text-foreground hover:underline',
              !pending &&
                'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
            )}
          >
            {pending ? 'Writing up…' : 'Write up'}
          </button>
        )}
        {lane === '' ? null : <span className="min-w-0 truncate">{lane}</span>}
        <time dateTime={item.at} data-date className="tabular shrink-0">
          {formatWhen(item.at, now)}
        </time>
      </span>
    </li>
  )
}

const INSTRUMENT_LABELS: Record<string, string> = {
  priced: 'priced',
  safe_post_money: 'SAFE post',
  safe_pre_money: 'SAFE pre',
  ccd: 'CCD',
}

/** A check on the deal's ledger; a voided one struck, with the void's day. */
function LedgerEntry({ item, last }: { item: LedgerItem; last: boolean }) {
  const { today } = useClock()
  return (
    <Row
      at={item.at}
      type={VERB_TYPES[item.verb] ?? 'invest'}
      last={last}
      end={
        item.voidedAt === null
          ? undefined
          : `voided ${formatDay(item.voidedAt, today)}`
      }
    >
      <span
        data-voided={item.voidedAt === null ? undefined : ''}
        className={cn(item.voidedAt !== null && 'text-graphite line-through')}
      >
        <span className="font-medium">{item.actorName ?? 'System'}</span>{' '}
        {VERB_LABELS[item.verb] ?? item.verb} ·{' '}
        <span className="mono text-micro">
          {fmtMoney(item.amount, item.currency, { compact: true })}{' '}
          {INSTRUMENT_LABELS[item.instrument] ?? item.instrument}
        </span>
      </span>
    </Row>
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
              <dt className="w-24 shrink-0 truncate field-label text-graphite">
                {bySlug.get(c.slug)?.name ?? c.slug}
              </dt>
              <dd className="min-w-0 truncate text-label">
                {renderValue(c.slug, c.to)}
                {c.citations.length > 0 ? (
                  <span className="ml-2 mono text-micro text-graphite">
                    {c.citations.map((r, j) => (
                      <span
                        key={j}
                        title={r.ref}
                        className={cn(r.missing && 'italic')}
                      >
                        {j > 0 ? ' · ' : ''}
                        {r.label}
                      </span>
                    ))}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Row>
  )
}
