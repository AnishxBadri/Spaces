import { readOptionProposals } from '@spaces/core/ai/attribute-ai'
import type { OptionProposal } from '@spaces/core/ai/attribute-ai'
import {
  readAddRecordPayload,
  readFileRecordPayload,
} from '@spaces/core/ai/discovery'
import { readDocumentKindPayload } from '@spaces/core/ai/document-kind'
import { readIdentityPayload } from '@spaces/core/ai/identity'
import { readLedgerEventPayload } from '@spaces/core/ai/ledger-event'
import type { LedgerEventPayload } from '@spaces/core/ai/ledger-event'
import { readNotePayload } from '@spaces/core/ai/note'
import { readSpaceTagPayload } from '@spaces/core/ai/space-tag'
import { readSupersedesPayload } from '@spaces/core/ai/supersedes'
import { taskPayloadSchema } from '@spaces/core/ai/task'
import { DOCUMENT_KIND_LABELS } from '@spaces/core/documents'
import { readRefileDocumentPayload } from '@spaces/core/documents/refile'
import { formatDay, formatNumber } from '@spaces/core/format'
import type { Json } from '@spaces/core/json'
import { fmtMoney } from '@spaces/core/portfolio/format'
import { decisionWords } from '#/lib/inbox/decision-words'
import type {
  CapturedPage,
  ColumnRunRow,
  DiscoveryRow,
  DuplicateCandidateRow,
  InboxRow,
  SuggestionField,
  SuggestionItem,
  SuggestionRecord,
} from '#/lib/inbox/queue'

/**
 * Today's Review rows: the open queue flattened into one row per proposal,
 * with the groups Review draws (a watch's space, a column run, an Ask
 * thread) as one row each over their children. Pure, so Today flattens the
 * queue after the held decisions leave it, and the tests read each kind.
 */

/** Review, narrowed to what a row is about. */
export type ReviewSearch = {
  record?: string
  space?: string
  lane?: 'duplicates'
}

/** What a leaf decides, and the toasts its hold shows. */
export type ProposalTarget =
  | {
      kind: 'suggestion'
      item: SuggestionItem
      /** A registry proposal's option: its primary adds it, for everyone. */
      option: OptionProposal | null
      accepted: string
      dismissed: string
    }
  | { kind: 'duplicate'; pair: DuplicateCandidateRow; dismissed: string }

/** One proposal, decided in place. */
export type ProposalLeaf = {
  kind: 'leaf'
  key: string
  /** The body's primary: the record, document, company or task it is about. */
  subject: string
  /** The body's context: `proposalLine`. */
  line: string
  who: string | null
  /** When it was proposed, ISO. */
  at: string
  primary: string
  dismiss: string
  /** The dismiss button's tooltip; null for none. */
  dismissTitle: string | null
  /** Where the row opens: Review, on its record, space or pair. */
  review: ReviewSearch
  target: ProposalTarget
}

/** Where a group row's verbs go. */
export type ProposalGroupOf =
  | { kind: 'discovery'; spaceId: string }
  | {
      kind: 'column_run'
      runId: string
      title: string
      /** What Accept all accepts; null when no child proposes a value. */
      attributeSlug: string | null
      /** The children Accept all takes. */
      taken: number
    }
  | { kind: 'ask_cards'; threadId: string }

/** A group of proposals: one row, its children under ▸/▾. */
export type ProposalGroup = {
  kind: 'group'
  key: string
  subject: string
  line: string
  who: string | null
  /** The oldest child's proposal, ISO. */
  at: string
  of: ProposalGroupOf
  children: ProposalLeaf[]
}

export type Proposal = ProposalLeaf | ProposalGroup

/** What a line names beside its proposal. */
export type LineContext = {
  today: string
  /** The record, when the row's subject is something else on it. */
  record: string | null
  /** A file-here card's record: the space path it is filed in now. */
  filedIn: string | null
  /** The card is a captured page's, not a record's. */
  captured: boolean
}

const NO_CONTEXT: Omit<LineContext, 'today'> = {
  record: null,
  filedIn: null,
  captured: false,
}

/** A value as the line prints it: an option by its label, money compact. */
function valueText(f: SuggestionField, today: string): string {
  const v = f.value
  if (v === null || v === '') return '—'
  const text = (x: Json) => (typeof x === 'string' ? x : JSON.stringify(x))
  const label = (id: Json) =>
    f.options?.options?.find((o) => o.id === id)?.label ?? text(id)
  switch (f.type) {
    case 'select':
    case 'status':
      return label(v)
    case 'multi_select':
      return (Array.isArray(v) ? v : [v]).map(label).join(', ')
    case 'checkbox':
      return v === true ? 'Yes' : 'No'
    case 'date':
      return typeof v === 'string' ? formatDay(v, today) || v : text(v)
    case 'number':
      return typeof v === 'number' || typeof v === 'string'
        ? formatNumber(v, f.options?.precision)
        : text(v)
    case 'currency':
      return typeof v === 'number'
        ? fmtMoney(v, f.options?.code ?? 'USD', { compact: true })
        : text(v)
    case 'rating':
      return typeof v === 'number'
        ? `${String(v)}/${String(f.options?.max ?? 5)}`
        : text(v)
    case 'record_reference':
      return typeof v === 'object' &&
        !Array.isArray(v) &&
        typeof v.name === 'string'
        ? v.name
        : text(v)
    default:
      return text(v)
  }
}

/** Money a model read: compact when the currency is an ISO code. */
const ledgerMoney = (amount: number, currency: string | null) =>
  currency !== null && /^[A-Z]{3}$/.test(currency)
    ? fmtMoney(amount, currency, { compact: true })
    : formatNumber(amount, 0)

const BASIS: Record<'round_price' | 'manual' | '409a', string> = {
  round_price: 'price',
  manual: 'manual',
  '409a': '409A',
}

function ledgerLine(ledger: LedgerEventPayload, today: string): string {
  if (ledger.event === 'round') {
    const r = ledger.proposed
    const currency = r.currency ?? ledger.before.currency
    const size =
      r.postMoney !== undefined
        ? ` at ${ledgerMoney(r.postMoney, currency)} post`
        : r.raised !== undefined
          ? ` · ${ledgerMoney(r.raised, currency)} raised`
          : ''
    return `${r.kind}${size}, ${formatDay(r.date.slice(0, 10), today) || r.date}`
  }
  const m = ledger.proposed
  const basis =
    m.basis === 'round_price' && ledger.before.roundKind !== null
      ? `${ledger.before.roundKind} price`
      : BASIS[m.basis]
  const day = formatDay(m.date.slice(0, 10), today) || m.date
  return `Mark at ${ledgerMoney(m.fairValue, m.currency)} · ${basis}, ${day}`
}

/** What a drafted note or task came from: its first live citation. */
const sourceOf = (item: SuggestionItem): string | null =>
  item.citations.find((c) => !c.missing && c.entityId !== null)?.label ?? null

const join = (parts: ReadonlyArray<string | null>) =>
  parts.filter((p) => p !== null && p !== '').join(' · ')

/**
 * The sentence a proposal's row says beside its subject, per kind:
 * `Funding stage → Series A`, `Belongs in Proptech / Property ops`.
 * A payload that does not read falls back to the kind's word.
 */
export function proposalLine(item: SuggestionItem, at: LineContext): string {
  const { record, today } = at
  switch (item.kind) {
    case 'attribute_patch': {
      const option = readOptionProposals(item.rationale).at(0)
      if (option !== undefined)
        return `New option ${JSON.stringify(option.label)} · for everyone`
      if (item.fields === null || item.fields.length === 0)
        return 'Field change'
      return item.fields
        .map((f) => `${f.name} → ${valueText(f, today)}`)
        .join(' · ')
    }
    case 'supersedes': {
      const pair = readSupersedesPayload(item.payload)
      return pair === null
        ? 'Newer version'
        : join([`Newer version of ${pair.olderName}`, record])
    }
    case 'space_tag': {
      const tag = readSpaceTagPayload(item.payload)
      return tag === null ? 'Space' : `Belongs in ${tag.label}`
    }
    case 'document_kind': {
      const kind = readDocumentKindPayload(item.payload)
      return kind === null
        ? 'Document type'
        : join([`Kind → ${DOCUMENT_KIND_LABELS[kind.kind]}`, record])
    }
    case 'note': {
      const from = sourceOf(item) ?? record
      return from === null ? 'Note' : `Note from ${from}`
    }
    case 'task': {
      const from = sourceOf(item) ?? record
      return from === null ? 'Task' : `Task from ${from}`
    }
    case 'ledger_event': {
      const ledger = readLedgerEventPayload(item.payload)
      return ledger === null ? 'Ledger event' : ledgerLine(ledger, today)
    }
    case 'identity': {
      const claim = readIdentityPayload(item.payload)
      if (claim === null) return 'Identity'
      if (at.captured) return `Captured page · matches ${claim.name}`
      return join([
        claim.role ?? 'Person',
        record === null ? null : `from ${record}`,
      ])
    }
    case 'add_record': {
      const card = readAddRecordPayload(item.payload)
      if (card === null) return 'New company'
      const oneLiner =
        item.rationale?.split('\n').at(0)?.trim() ??
        card.evidence.at(0)?.title ??
        null
      return join([card.domain, oneLiner])
    }
    case 'file_record': {
      const card = readFileRecordPayload(item.payload)
      if (card === null) return 'File here'
      return at.filedIn === null ? card.domain : `Filed in ${at.filedIn}`
    }
    case 'refile_document': {
      const move = readRefileDocumentPayload(item.payload)
      return move === null
        ? 'Re-file'
        : `Re-file from ${move.fromName} to ${move.toName}`
    }
  }
}

/** A pair's line: `Possibly the same · domain on both`. */
export function pairLine(pair: DuplicateCandidateRow): string {
  if (pair.reason.shared)
    return `Possibly the same · ${pair.reason.shared} on both`
  if (pair.reason.name_similarity)
    return `Possibly the same · names ${String(Math.round(pair.score * 100))}% alike`
  return 'Possibly the same'
}

/** The who lane: where a proposal came from. */
export function proposerOf(
  item: SuggestionItem,
  page: CapturedPage | null,
): string {
  if (page !== null) return 'Captured'
  if (item.source !== null) return `Via ${item.source}`
  return item.origin.via === 'app' ? 'AI' : 'Via integration'
}

/** The subject a record card's proposal is about. */
function subjectOf(item: SuggestionItem, record: SuggestionRecord): string {
  switch (item.kind) {
    case 'supersedes':
      return readSupersedesPayload(item.payload)?.newerName ?? record.name
    case 'note':
      return readNotePayload(item.payload)?.title ?? record.name
    case 'task': {
      const task = taskPayloadSchema.safeParse(item.payload)
      return task.success ? task.data.title : record.name
    }
    case 'ledger_event':
      return readLedgerEventPayload(item.payload)?.companyName ?? record.name
    case 'refile_document':
      return (
        readRefileDocumentPayload(item.payload)?.documentName ?? record.name
      )
    default:
      return record.name
  }
}

/** The line names the record only where the subject is something on it. */
const NAMES_RECORD = new Set<SuggestionItem['kind']>([
  'supersedes',
  'note',
  'task',
  'identity',
])

const optionOf = (item: SuggestionItem): OptionProposal | null =>
  item.kind === 'attribute_patch'
    ? (readOptionProposals(item.rationale).at(0) ?? null)
    : null

/** A record card's proposal as a row. */
function recordLeaf(
  item: SuggestionItem,
  record: SuggestionRecord,
  page: CapturedPage | null,
  who: string,
  today: string,
): ProposalLeaf {
  const option = optionOf(item)
  const words = decisionWords(item, page)
  const subject =
    item.kind === 'identity' && page === null
      ? (readIdentityPayload(item.payload)?.name ?? record.name)
      : subjectOf(item, record)
  return {
    kind: 'leaf',
    key: `suggestion:${item.id}`,
    subject,
    line: proposalLine(item, {
      today,
      record: NAMES_RECORD.has(item.kind) ? record.name : null,
      filedIn: null,
      captured: page !== null,
    }),
    who,
    at: item.createdAt,
    primary: option === null ? words.accept : 'Add option',
    dismiss: words.reject,
    dismissTitle: words.rejectTitle,
    review: { record: record.id },
    target: {
      kind: 'suggestion',
      item,
      option,
      accepted:
        option === null
          ? `Accepted on ${record.name}`
          : `${JSON.stringify(option.label)} added to ${option.name}`,
      dismissed: `Dismissed on ${record.name}`,
    },
  }
}

/** A company a watch found, as a row under its space. */
function discoveryLeaf(
  item: SuggestionItem,
  group: DiscoveryRow,
  filedIn: Readonly<Record<string, string>>,
  today: string,
): ProposalLeaf {
  const words = decisionWords(item)
  const card =
    item.kind === 'file_record'
      ? readFileRecordPayload(item.payload)
      : readAddRecordPayload(item.payload)
  const name = card?.name ?? 'The card'
  const filed =
    card !== null && 'entityId' in card
      ? (filedIn[card.entityId] ?? null)
      : null
  return {
    kind: 'leaf',
    key: `suggestion:${item.id}`,
    subject: name,
    line: proposalLine(item, { today, ...NO_CONTEXT, filedIn: filed }),
    who: proposerOf(item, null),
    at: item.createdAt,
    primary: words.accept,
    dismiss: words.reject,
    dismissTitle: words.rejectTitle,
    review: { space: group.space.id },
    target: {
      kind: 'suggestion',
      item,
      option: null,
      accepted: `${name} accepted into ${group.space.name}`,
      dismissed: `${name} dismissed from ${group.space.name}`,
    },
  }
}

function pairLeaf(pair: DuplicateCandidateRow): ProposalLeaf {
  const names = `${pair.a.name} ⇄ ${pair.b.name}`
  return {
    kind: 'leaf',
    key: `pair:${pair.id}`,
    subject: names,
    line: pairLine(pair),
    who: null,
    at: pair.latestAt,
    primary: 'Compare',
    dismiss: 'Not the same',
    dismissTitle: null,
    review: { record: pair.a.id, lane: 'duplicates' },
    target: { kind: 'duplicate', pair, dismissed: `${names} dismissed` },
  }
}

/** "Column run · Why now? · Screening" → "Why now? · Screening". */
const columnRunTitle = (task: string): string =>
  task.split(' · ').slice(1).join(' · ') || task

const oldest = (children: ReadonlyArray<ProposalLeaf>, fallback: string) =>
  children.reduce((min, c) => (c.at < min ? c.at : min), fallback)

const plural = (n: number, one: string, many: string) =>
  `${String(n)} ${n === 1 ? one : many}`

function runGroup(row: ColumnRunRow, today: string): ProposalGroup {
  const children = row.cards.flatMap((c) =>
    c.suggestions.map((s) =>
      recordLeaf(s, c.record, c.page, 'Column run', today),
    ),
  )
  const slug = row.attributeSlug
  const fields = row.cards
    .flatMap((c) => c.suggestions)
    .flatMap((s) => s.fields ?? [])
  const taken =
    slug === null
      ? 0
      : row.cards
          .flatMap((c) => c.suggestions)
          .filter((s) => s.fields?.some((f) => f.slug === slug) === true).length
  return {
    kind: 'group',
    key: `run:${row.id}`,
    subject: columnRunTitle(row.run.task),
    line: join([
      fields.find((f) => f.slug === slug)?.name ?? null,
      `${String(children.length)} waiting`,
      row.run.status === 'running'
        ? 'running'
        : row.run.status === 'failed'
          ? 'stopped'
          : null,
    ]),
    who: row.run.author ?? 'Column run',
    at: oldest(children, row.latestAt),
    of: {
      kind: 'column_run',
      runId: row.id,
      title: columnRunTitle(row.run.task),
      attributeSlug: slug,
      taken,
    },
    children,
  }
}

/** What Today reads off the queue beside the rows. */
export type FlattenContext = {
  today: string
  /** A file-here card's record by id: where it is filed now. */
  filedIn: Readonly<Record<string, string>>
}

/**
 * The queue as Today's rows, in the queue's order:
 * - a record card gives one row per suggestion, and a pair one row;
 * - a watch's space, a column run and an Ask thread each give one group
 *   row over a row per child.
 * A group with no children left gives nothing.
 */
export function flattenInbox(
  rows: ReadonlyArray<InboxRow>,
  ctx: FlattenContext,
): Proposal[] {
  const { today } = ctx
  return rows.flatMap((row): Proposal[] => {
    switch (row.kind) {
      case 'suggestion':
        return row.suggestions.map((s) =>
          recordLeaf(s, row.record, row.page, proposerOf(s, row.page), today),
        )
      case 'duplicate_candidate':
        return [pairLeaf(row)]
      case 'discovery': {
        const children = row.suggestions.map((s) =>
          discoveryLeaf(s, row, ctx.filedIn, today),
        )
        if (children.length === 0) return []
        const toAdd = row.suggestions.filter((s) => s.kind === 'add_record')
        const toFile = children.length - toAdd.length
        return [
          {
            kind: 'group',
            key: `discovery:${row.id}`,
            subject: row.space.path,
            line: join([
              toAdd.length > 0 ? `${String(toAdd.length)} to add` : null,
              toFile > 0 ? `${String(toFile)} to file` : null,
            ]),
            who: row.via.length === 0 ? null : `Via ${row.via.join(', ')}`,
            at: oldest(children, row.latestAt),
            of: { kind: 'discovery', spaceId: row.space.id },
            children,
          },
        ]
      }
      case 'column_run': {
        const group = runGroup(row, today)
        return group.children.length === 0 ? [] : [group]
      }
      case 'ask_cards': {
        const children = row.cards.flatMap((c) =>
          c.suggestions.map((s) =>
            recordLeaf(s, c.record, c.page, 'Via Ask', today),
          ),
        )
        if (children.length === 0) return []
        return [
          {
            kind: 'group',
            key: `ask:${row.id}`,
            subject: row.title === '' ? 'Ask' : row.title,
            line: plural(children.length, 'card', 'cards'),
            who: 'Via Ask',
            at: oldest(children, row.latestAt),
            of: { kind: 'ask_cards', threadId: row.id },
            children,
          },
        ]
      }
    }
  })
}

/**
 * What a column run's Accept all says once it lands short:
 * `7 accepted · 2 refused, the values changed`. Null when nothing was refused.
 */
export function acceptAllShortfall(
  outcomes: ReadonlyArray<{ ok: boolean }>,
): string | null {
  const refused = outcomes.filter((o) => !o.ok).length
  if (refused === 0) return null
  return `${String(outcomes.length - refused)} accepted · ${String(refused)} refused, the values changed`
}
