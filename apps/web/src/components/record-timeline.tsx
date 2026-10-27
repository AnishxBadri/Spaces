import { useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { Layers } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { toast } from 'sonner'
import { OptionChip, optionLabel, refName } from './attributes/value-editor'
import { EmailModal } from './email-dialog'
import { Band, EmptyRow, FoldRow } from './ledger-section'
import { PickPopover } from './record/details-add'
import { ThreadRow } from './record/thread-row'
import { useConfirm } from './ui/confirm-dialog'
import { MENU_RULE, MoreMenu } from './ui/more-menu'
import type { MoreMenuEntry } from './ui/more-menu'
import { Segmented } from './ui/segmented'
import { Switch } from './ui/switch'
import type { RegistryEntry, RefNames } from './attributes/value-editor'
import { fmtMoney } from '@spaces/core/portfolio/format'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import {
  fileInteractionOnEntity,
  getRecordEmailVisibility,
  searchEntities,
  setRecordEmailVisibility,
  unlinkInteractionFromEntity,
  writeUpInteraction,
} from '#/lib/server-fns'
import type { getRecordTimeline } from '#/lib/server-fns'
import { openModalId } from '#/lib/modal-search'
import {
  THREAD_KINDS,
  threadCounts,
  threadShown,
  threadsOf,
} from '#/lib/timeline/threads'
import type { Thread, ThreadKind } from '#/lib/timeline/threads'
import { byWeek } from '#/lib/timeline/weeks'
import { cn } from '#/lib/utils'

/**
 * A record's Interactions and History tabs.
 * - Interactions: a toolbar (the kinds as a `Segmented`, `With files` as a
 *   switch), then one `ThreadRow` per thread under week bands, each ending
 *   on its `···`. The head's `Log interaction` is the composer.
 * - History: 40px rows under week bands — a glyph, a sentence, a mono figure
 *   and the day — paged at 25. An attribute burst opens in place.
 */

type Items = Awaited<ReturnType<typeof getRecordTimeline>>
type Item = Items[number]
type InteractionItem = Extract<Item, { type: 'interaction' }>
type MacroItem = Extract<Item, { type: 'macro' }>
type BurstItem = Extract<Item, { type: 'attrs' }>
type LedgerItem = Extract<Item, { type: 'ledger' }>

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

/** Each verb's kind, which picks the glyph its History row wears. */
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

/**
 * The glyph lane: mark ■, stage ▤, enrich ✦, file ▯, a burst ›, merge ⇄,
 * a space its layers; the ledger's other verbs wear the mark's square.
 */
export const HISTORY_GLYPHS: Record<string, string> = {
  born: '+',
  deal: '+',
  note: '¶',
  file: '▯',
  merge: '⇄',
  rename: '›',
  term: '¶',
  mandate: '¶',
  signal: '✦',
  enrich: '✦',
  holding: '■',
  writeoff: '■',
  invest: '■',
  round: '■',
  mark: '■',
  distrib: '■',
  void: '■',
  stage: '▤',
  edit: '›',
}

/** How many History rows show before the fold. */
export const HISTORY_PAGE = 25

/** How many threads show before the fold. */
export const INTERACTIONS_FOLD = 20

/**
 * A record's ledger split into its two tabs: the conversations, and the
 * bookkeeping (stage moves, attribute bursts, filings, the portfolio's
 * verbs).
 */
function splitLedger(items: Items): {
  interactions: Array<InteractionItem>
  history: Array<Exclude<Item, InteractionItem>>
} {
  return {
    interactions: items.filter(
      (i): i is InteractionItem => i.type === 'interaction',
    ),
    history: items.filter(
      (i): i is Exclude<Item, InteractionItem> => i.type !== 'interaction',
    ),
  }
}

const KIND_LABELS: Record<ThreadKind, string> = {
  all: 'All',
  email: 'Email',
  meeting: 'Meetings',
  call: 'Calls',
}

/**
 * The toolbar's `···` for a viewer with private emails here: their emails
 * with this record, opened to the workspace or not (the record override).
 * Its one item draws as a switch, absent until the state has been read.
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
 * The Interactions tab.
 * - `record` lets the email window widen for this record, names it in
 *   `Unlink from <record>…`, and puts the override in the toolbar once the
 *   viewer has private emails here.
 * - The email `?modal=email&id=` opens stays highlighted behind its window,
 *   unfolded to when it sits past the fold.
 * - Empty, it is one `Interactions +` row, which `logInteraction` wraps in
 *   the log window.
 */
export function RecordInteractions({
  items,
  record,
  logInteraction,
}: {
  items: Items
  record?: { id: string; name: string } | undefined
  logInteraction?: ((trigger: ReactElement) => ReactNode) | undefined
}) {
  const { interactions } = splitLedger(items)
  const { today } = useClock()
  const [kind, setKind] = useState<ThreadKind>('all')
  const [withFiles, setWithFiles] = useState(false)
  const [unfolded, setUnfolded] = useState(false)
  const opened = openModalId(useSearch({ strict: false }), 'email')
  const threads = threadsOf(interactions)
  if (threads.length === 0)
    return logInteraction ? (
      <>{logInteraction(<EmptyRow name="Interactions" />)}</>
    ) : (
      <EmptyRow name="Interactions" />
    )

  const counts = threadCounts(threads)
  const listed = threads.filter((t) => threadShown(t, kind, withFiles))
  const openedAt = listed.findIndex((t) => t.row.id === opened)
  const shown =
    unfolded || openedAt >= INTERACTIONS_FOLD
      ? listed
      : listed.slice(0, INTERACTIONS_FOLD)
  const bands = byWeek(
    shown.map((t) => ({ ...t, at: t.row.at })),
    today,
  )
  return (
    <div className="flex flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-rule px-3">
        <Segmented
          label="Show interactions"
          value={kind}
          onChange={setKind}
          options={THREAD_KINDS.map((k) =>
            k === 'all'
              ? { id: k, label: KIND_LABELS[k] }
              : { id: k, label: KIND_LABELS[k], count: counts[k] },
          )}
        />
        <div className="flex shrink-0 items-center gap-3">
          <Switch checked={withFiles} onCheckedChange={setWithFiles}>
            With files
            {counts.files > 0 ? (
              <span className="tabular mono text-micro text-graphite">
                {counts.files}
              </span>
            ) : null}
          </Switch>
          {record !== undefined &&
          interactions.some((i) => i.kind === 'email' && i.ownPrivate) ? (
            <EmailVisibilityMenu recordId={record.id} />
          ) : null}
        </div>
      </div>
      {bands.map((b) => (
        <section key={b.band} aria-label={b.band} className="flex flex-col">
          <Band label={b.band} />
          <ul>
            {b.rows.map((t) => (
              <ThreadRow
                key={t.row.id}
                item={t.row}
                messages={t.messages}
                tab="interactions"
                highlighted={t.row.id === opened}
                menu={<ThreadMenu thread={t} record={record} />}
              />
            ))}
          </ul>
        </section>
      ))}
      {listed.length === 0 ? (
        <p className="px-3 py-2 text-label text-graphite">
          Nothing matches that filter.
        </p>
      ) : null}
      {shown.length < listed.length ? (
        <FoldRow
          hidden={listed.length - shown.length}
          onShow={() => setUnfolded(true)}
        />
      ) : null}
      <EmailModal recordId={record?.id ?? null} />
    </div>
  )
}

/** The page's own address, with `search` in place of its query. */
function hereWith(search: Record<string, string>): string {
  const url = new URL(window.location.href)
  url.search = new URLSearchParams(search).toString()
  return url.toString()
}

/**
 * A thread row's `···`: Open · Write up · Copy link · File on a deal… ·
 * rule · Unlink from <record>….
 * - Open is the email's window, the meeting's, or the write-up.
 * - Write up is offered while there is no body and the body is not private.
 * - Unlink only where this record holds its own edge, not one a deal reads
 *   through its company or people.
 */
function ThreadMenu({
  thread,
  record,
}: {
  thread: Thread<InteractionItem>
  record: { id: string; name: string } | undefined
}) {
  const item = thread.row
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm, confirmDialog } = useConfirm()
  const [filing, setFiling] = useState(false)
  const [writing, setWriting] = useState(false)
  const searchDeals = useCallback(
    async (q: string) => {
      const rows = await searchEntities({ data: { q, kinds: ['deal'] } })
      return rows.filter((r) => r.id !== record?.id)
    },
    [record?.id],
  )

  const windowOf: 'email' | 'meeting' | null =
    item.kind === 'email' ? 'email' : item.kind === 'meeting' ? 'meeting' : null

  function open() {
    if (windowOf !== null) {
      void navigate({
        to: '.',
        search: (prev) => ({
          ...prev,
          tab: 'interactions' as const,
          modal: windowOf,
          id: item.id,
        }),
        resetScroll: false,
      })
      return
    }
    if (item.noteId !== null)
      void navigate({ to: '/notes/$noteId', params: { noteId: item.noteId } })
  }

  async function writeUp() {
    setWriting(true)
    try {
      const { noteId } = await writeUpInteraction({
        data: { interactionId: item.id },
      })
      void router.invalidate()
      void navigate({ to: '/notes/$noteId', params: { noteId } })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not write it up')
    } finally {
      setWriting(false)
    }
  }

  const link = () =>
    windowOf !== null
      ? hereWith({ tab: 'interactions', modal: windowOf, id: item.id })
      : item.noteId !== null
        ? new URL(`/notes/${item.noteId}`, window.location.href).toString()
        : hereWith({ tab: 'interactions' })

  async function unlink(from: { id: string; name: string }) {
    const ok = await confirm({
      title: `Unlink from ${from.name}?`,
      body: `${item.subject || 'This interaction'} leaves ${from.name}. It stays on every other record it is filed on.`,
      action: 'Unlink',
    })
    if (!ok) return
    try {
      await unlinkInteractionFromEntity({
        data: { interactionId: item.id, entityId: from.id },
      })
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not unlink')
    }
  }

  const items: Array<MoreMenuEntry> = [
    ...(windowOf !== null || item.noteId !== null
      ? [{ label: 'Open', onSelect: open }]
      : []),
    ...(item.noteId === null && !item.privateBody
      ? [
          {
            label: writing ? 'Writing up…' : 'Write up',
            disabled: writing,
            onSelect: () => void writeUp(),
          },
        ]
      : []),
    { label: 'Copy link', copy: link },
    { label: 'File on a deal…', opens: true, onSelect: () => setFiling(true) },
    MENU_RULE,
    ...(record !== undefined && item.linked
      ? [
          {
            label: `Unlink from ${record.name}…`,
            destructive: true,
            opens: true,
            onSelect: () => void unlink(record),
          },
        ]
      : []),
  ]

  return (
    <>
      <MoreMenu
        variant="row"
        label={item.subject || 'interaction'}
        items={items}
      />
      <PickPopover
        open={filing}
        onOpenChange={setFiling}
        trigger={<span aria-hidden className="size-0" />}
        placeholder="File on a deal…"
        search={searchDeals}
        onPick={async (deal) => {
          const { filed } = await fileInteractionOnEntity({
            data: { interactionId: item.id, entityId: deal.id },
          })
          toast(filed ? `Filed on ${deal.name}` : `Already on ${deal.name}`)
          void router.invalidate()
        }}
      />
      {confirmDialog}
    </>
  )
}

type HistoryItem = Exclude<Item, InteractionItem>

/**
 * The figure a macro row ends on, from its facts: a money figure, how many
 * attributes an enrichment wrote, the document, the merged record, the
 * space's path, or `from an email`. Null for a verb with nothing to add.
 */
export function macroFigure(item: Pick<MacroItem, 'facts'>): string | null {
  const f = item.facts
  if (f.amount !== null && f.currency !== null)
    return fmtMoney(f.amount, f.currency, { compact: true })
  if (f.fields !== null)
    return `${String(f.fields)} attribute${f.fields === 1 ? '' : 's'}`
  if (f.document !== null) return f.document
  if (f.merged !== null) return f.merged
  if (f.space !== null) return f.space
  return f.fromEmail ? 'from an email' : null
}

/** A burst's figure: the first two attributes by name, then `+n`. */
export function burstFigure(names: ReadonlyArray<string>): string {
  const shown = names.slice(0, 2)
  const rest = names.length - shown.length
  return rest > 0 ? `${shown.join(', ')}, +${String(rest)}` : shown.join(', ')
}

/**
 * The History tab: week bands of 40px rows, paged at 25 with a fold.
 * `registry` names the attributes a burst changed and reads its options.
 */
export function RecordHistory({
  items,
  registry,
  refNames,
}: {
  items: Items
  registry: Array<RegistryEntry>
  refNames?: RefNames | undefined
}) {
  const { history } = splitLedger(items)
  const { today } = useClock()
  const [unfolded, setUnfolded] = useState(false)
  // Nothing to add by hand, so no `History +` row: an empty tab is empty.
  if (history.length === 0) return null
  const shown = unfolded ? history : history.slice(0, HISTORY_PAGE)
  return (
    <div className="flex flex-col">
      {byWeek(shown, today).map((b) => (
        <section key={b.band} aria-label={b.band} className="flex flex-col">
          <Band label={b.band} />
          <ul>
            {b.rows.map((item) => (
              <HistoryEntry
                key={item.id}
                item={item}
                registry={registry}
                refNames={refNames}
              />
            ))}
          </ul>
        </section>
      ))}
      {shown.length < history.length ? (
        <FoldRow
          hidden={history.length - shown.length}
          onShow={() => setUnfolded(true)}
        />
      ) : null}
    </div>
  )
}

function HistoryEntry({
  item,
  registry,
  refNames,
}: {
  item: HistoryItem
  registry: Array<RegistryEntry>
  refNames: RefNames | undefined
}) {
  if (item.type === 'macro')
    return (
      <Row
        at={item.at}
        kind={VERB_TYPES[item.verb] ?? 'edit'}
        figure={macroFigure(item)}
      >
        {item.actorName ?? 'System'} {VERB_LABELS[item.verb] ?? item.verb}
      </Row>
    )
  if (item.type === 'ledger') return <LedgerEntry item={item} />
  return <AttrBurst item={item} registry={registry} refNames={refNames} />
}

/** One History row: the glyph, the sentence, the mono figure, the day. */
function Row({
  at,
  kind,
  children,
  figure,
  struck = false,
}: {
  at: string
  kind: string
  children: ReactNode
  figure: ReactNode
  struck?: boolean
}) {
  const { today } = useClock()
  return (
    <li
      data-history={kind}
      className="flex h-ledger-row items-center gap-3 border-b border-rule px-3"
    >
      <Glyph kind={kind} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-ui',
          struck ? 'text-graphite line-through' : 'text-foreground',
        )}
      >
        {children}
      </span>
      <Figure struck={struck}>{figure}</Figure>
      <Day at={at} today={today} />
    </li>
  )
}

/** The 16px glyph lane; a space wears its layers. */
function Glyph({ kind }: { kind: string }) {
  return (
    <span
      aria-hidden
      data-glyph={kind}
      className="flex w-4 shrink-0 justify-center mono text-ui text-graphite"
    >
      {kind === 'space' ? (
        <Layers className="size-3.5" strokeWidth={1.75} />
      ) : (
        (HISTORY_GLYPHS[kind] ?? '·')
      )}
    </span>
  )
}

function Figure({
  children,
  struck = false,
}: {
  children: ReactNode
  struck?: boolean
}) {
  return children === null ? null : (
    <span
      data-figure
      className={cn(
        'flex max-w-80 min-w-0 shrink-0 items-center gap-1.5 truncate mono text-micro',
        struck ? 'text-graphite line-through' : 'text-foreground',
      )}
    >
      {children}
    </span>
  )
}

function Day({ at, today }: { at: string; today: string }) {
  return (
    <time
      dateTime={at}
      className="w-18 shrink-0 text-right mono text-micro text-graphite"
    >
      {formatDay(at, today)}
    </time>
  )
}

const INSTRUMENT_LABELS: Record<string, string> = {
  priced: 'priced',
  safe_post_money: 'SAFE post',
  safe_pre_money: 'SAFE pre',
  ccd: 'CCD',
}

/** A check on the deal's ledger; a voided one struck, with the void's day. */
function LedgerEntry({ item }: { item: LedgerItem }) {
  const { today } = useClock()
  const voided = item.voidedAt !== null
  return (
    <Row
      at={item.at}
      kind={VERB_TYPES[item.verb] ?? 'invest'}
      struck={voided}
      figure={`${fmtMoney(item.amount, item.currency, { compact: true })} ${INSTRUMENT_LABELS[item.instrument] ?? item.instrument}`}
    >
      <span data-voided={voided ? '' : undefined}>
        {item.actorName ?? 'System'} {VERB_LABELS[item.verb] ?? item.verb}
      </span>
      {item.voidedAt === null ? null : (
        <span className="ml-2 inline-block mono text-micro text-graphite">
          voided {formatDay(item.voidedAt, today)}
        </span>
      )}
    </Row>
  )
}

/**
 * An attribute burst: `Priya Raman changed 3 attributes` with their names in
 * the figure, or a stage move with `Diligence → Term sheet`. Opened, it is a
 * bone head row over one row per change: the label, then `90 → 120` in mono
 * (options as badges).
 */
function AttrBurst({
  item,
  registry,
  refNames,
}: {
  item: BurstItem
  registry: Array<RegistryEntry>
  refNames: RefNames | undefined
}) {
  const [open, setOpen] = useState(false)
  const { today } = useClock()
  const bySlug = new Map(registry.map((d) => [d.slug, d]))
  const nameOf = (slug: string) => bySlug.get(slug)?.name ?? slug
  const stage = item.changes.find((c) => c.slug === 'stage')
  const stageDef = bySlug.get('stage')
  const kind = stage ? 'stage' : item.source === 'merge' ? 'merge' : 'edit'
  const n = item.changes.length
  const sentence = `${burstActorLabel(item)} ${
    item.source === 'merge' ? 'rewrote' : 'changed'
  } ${stage && n === 1 ? 'the stage' : `${String(n)} attribute${n === 1 ? '' : 's'}`}`

  const figure =
    stage && n === 1 ? (
      <ChangeValue
        def={stageDef}
        from={stage.from}
        to={stage.to}
        refNames={refNames}
      />
    ) : (
      burstFigure(item.changes.map((c) => nameOf(c.slug)))
    )

  return (
    <li data-history={kind} className="flex flex-col border-b border-rule">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'focus-ring-inset flex h-ledger-row w-full items-center gap-3 px-3 text-left',
          open ? 'bg-bone' : 'hover:bg-bone',
        )}
      >
        {open ? (
          <span
            aria-hidden
            className="flex w-4 shrink-0 justify-center mono text-ui text-graphite"
          >
            ⌄
          </span>
        ) : (
          <Glyph kind={kind} />
        )}
        <span className="min-w-0 flex-1 truncate text-ui text-foreground">
          {sentence}
        </span>
        {open ? null : <Figure>{figure}</Figure>}
        <Day at={item.at} today={today} />
      </button>
      {open ? (
        <dl className="flex flex-col">
          {item.changes.map((c, i) => (
            <div
              key={i}
              data-change={c.slug}
              className="flex h-ledger-row items-center gap-3 border-t border-rule px-3"
            >
              <span aria-hidden className="w-4 shrink-0" />
              <dt className="w-40 shrink-0 truncate text-label text-graphite">
                {nameOf(c.slug)}
              </dt>
              <dd className="flex min-w-0 flex-1 items-center gap-3 mono text-micro text-foreground">
                <ChangeValue
                  def={bySlug.get(c.slug)}
                  from={c.from}
                  to={c.to}
                  refNames={refNames}
                />
                {c.citations.length > 0 ? (
                  <span className="min-w-0 truncate text-graphite">
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
    </li>
  )
}

/** A value as History prints it: an option's label, a record's name, text. */
function valueText(
  def: RegistryEntry | undefined,
  value: unknown,
  refNames: RefNames | undefined,
): string {
  if (value == null) return '—'
  if (def === undefined) return String(value)
  if (def.type === 'select' || def.type === 'status')
    return optionLabel(def, value)
  if (def.type === 'multi_select' && Array.isArray(value))
    return value.map((v) => optionLabel(def, v)).join(', ')
  if (def.type === 'record_reference' || def.type === 'actor_reference') {
    const ids = Array.isArray(value) ? value : [value]
    return ids.map((id) => refName(refNames, String(id))).join(', ')
  }
  return String(value)
}

/**
 * `from → to`: an option's new value is its badge, the old one its label;
 * a first write prints the new value alone.
 */
function ChangeValue({
  def,
  from,
  to,
  refNames,
}: {
  def: RegistryEntry | undefined
  from: unknown
  to: unknown
  refNames: RefNames | undefined
}) {
  const option =
    def !== undefined &&
    (def.type === 'select' || def.type === 'status') &&
    to != null
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {from == null ? null : (
        <>
          <span className="min-w-0 truncate">
            {valueText(def, from, refNames)}
          </span>
          <span aria-hidden>→</span>
        </>
      )}
      {option ? (
        <OptionChip def={def} id={to} className="font-sans" />
      ) : (
        <span className="min-w-0 truncate">{valueText(def, to, refNames)}</span>
      )}
    </span>
  )
}
