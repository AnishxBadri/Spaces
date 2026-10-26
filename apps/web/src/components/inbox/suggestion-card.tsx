import { Link, useRouter } from '@tanstack/react-router'
import { Check, CheckCheck } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { OptionChip } from '#/components/attributes/value-editor'
import { Button } from '#/components/ui/button'
import { checkboxClasses } from '#/components/ui/checkbox'
import { readOptionProposals } from '@spaces/core/ai/attribute-ai'
import { OptionProposalBody } from './option-proposal'
import { CapturedPageHeading } from './captured-page-heading'
import { readIdentityPayload } from '@spaces/core/ai/identity'
import type { IdentityPayload } from '@spaces/core/ai/identity'
import { readNotePayload } from '@spaces/core/ai/note'
import type { NotePayload } from '@spaces/core/ai/note'
import { readSpaceTagPayload } from '@spaces/core/ai/space-tag'
import { taskPayloadSchema } from '@spaces/core/ai/task'
import type { SpaceTagPayload } from '@spaces/core/ai/space-tag'
import {
  readAddRecordPayload,
  readFileRecordPayload,
} from '@spaces/core/ai/discovery'
import type { DiscoveryEvidence } from '@spaces/core/ai/discovery'
import { readDocumentKindPayload } from '@spaces/core/ai/document-kind'
import { readSupersedesPayload } from '@spaces/core/ai/supersedes'
import type { SupersedesPayload } from '@spaces/core/ai/supersedes'
import type { DocumentKindPayload } from '@spaces/core/ai/document-kind'
import { readRefileDocumentPayload } from '@spaces/core/documents/refile'
import { readLedgerEventPayload } from '@spaces/core/ai/ledger-event'
import type { LedgerEventPayload } from '@spaces/core/ai/ledger-event'
import type { RefileDocumentPayload } from '@spaces/core/documents/refile'
import { DOCUMENT_KIND_LABELS } from '@spaces/core/documents'
import { formatDay, formatNumber } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { fmtMoney, fmtPct } from '@spaces/core/portfolio/format'
import {
  acceptSuggestion,
  acceptSuggestionColumn,
  acceptSuggestionsForRecord,
  rejectSuggestion,
} from '#/lib/server-fns'
import type {
  BatchOutcome,
  SuggestionField,
  SuggestionItem,
  SuggestionKind,
  SuggestionRow,
} from '#/lib/server-fns'
import { recordPath } from '#/lib/record-path'
import { cn } from '#/lib/utils'

/**
 * The suggestion card — every open suggestion on one record under its serif
 * name, one entry per suggestion, each accepted or dismissed on its own. The
 * entry is a mono line, the proposal, the rationale and citations, and a
 * bone foot with the decision.
 *
 * Generic over `suggestion.kind`: a kind with a body in `SUGGESTION_BODIES`
 * draws it, every other kind prints its payload in the same row shape. The
 * later lanes add a body here, not a page.
 */

/** Where "produced by this run" goes: the run, opened on the Usage page. */
export const usageRunHref = (runId: string): string =>
  `/settings/usage?run=${encodeURIComponent(runId)}`

/** The word a person reads for each kind. Exhaustive by type. */
export const SUGGESTION_KIND_WORD: Record<SuggestionKind, string> = {
  attribute_patch: 'Field change',
  note: 'Note',
  ledger_event: 'Ledger event',
  identity: 'Identity',
  document_kind: 'Document type',
  space_tag: 'Space',
  task: 'Task',
  add_record: 'New company',
  file_record: 'File here',
  supersedes: 'Newer version',
  refile_document: 'Re-file',
}

/**
 * What a field row can do beyond showing its value: accept its
 * attribute on every record that proposes it, and show why the last batch
 * could not apply it. Null where the row is drawn read-only.
 */
export type FieldActions = {
  pending: boolean
  /** The last batch's refusal for this field of this suggestion, if any. */
  failureOf: (suggestionId: string, slug: string) => string | null
  onAcceptColumn: (field: SuggestionField) => void
}

type BodyProps = { item: SuggestionItem; actions: FieldActions | null }
type SuggestionBody = (props: BodyProps) => React.ReactNode

/**
 * One body per kind that has a sub-renderer. A missing key is the case
 * `PayloadBody` exists for, never a crash.
 */
const SUGGESTION_BODIES: Partial<Record<SuggestionKind, SuggestionBody>> = {
  // Fields draw as the entry's grid; this body is what a patch with none
  // draws instead.
  attribute_patch: ({ item, actions }) =>
    readOptionProposals(item.rationale).length > 0 ? (
      // A registry proposal — an empty patch naming an option an AI
      // attribute's classify run wanted. "Add option" is its explicit write.
      <OptionProposalBody suggestionId={item.id} rationale={item.rationale} />
    ) : (
      <PayloadBody item={item} actions={actions} />
    ),
  identity: ({ item, actions }) => {
    const claim = readIdentityPayload(item.payload)
    return claim ? (
      <IdentityBody claim={claim} />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
  document_kind: ({ item, actions }) => {
    const proposed = readDocumentKindPayload(item.payload)
    return proposed ? (
      <DocumentKindBody proposed={proposed} />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
  note: ({ item, actions }) => {
    const draft = readNotePayload(item.payload)
    return draft ? (
      <NoteDraftBody draft={draft} />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
  space_tag: ({ item, actions }) => {
    const proposed = readSpaceTagPayload(item.payload)
    return proposed ? (
      <SpaceTagBody proposed={proposed} />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
  task: ({ item, actions }) => {
    const proposed = taskPayloadSchema.safeParse(item.payload)
    return proposed.success ? (
      <TaskBody title={proposed.data.title} due={proposed.data.due} />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
  add_record: ({ item, actions }) => {
    const card = readAddRecordPayload(item.payload)
    return card ? (
      <DiscoveryBody
        name={card.name}
        domain={card.domain}
        evidence={card.evidence}
      />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
  supersedes: ({ item, actions }) => {
    const pair = readSupersedesPayload(item.payload)
    return pair ? (
      <SupersedesBody pair={pair} />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
  file_record: ({ item, actions }) => {
    const card = readFileRecordPayload(item.payload)
    return card ? (
      <DiscoveryBody
        name={card.name}
        domain={card.domain}
        evidence={card.evidence}
      />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
  refile_document: ({ item, actions }) => {
    const move = readRefileDocumentPayload(item.payload)
    return move ? (
      <RefileBody move={move} />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
  ledger_event: ({ item, actions }) => {
    const ledger = readLedgerEventPayload(item.payload)
    return ledger ? (
      <LedgerEventBody ledger={ledger} />
    ) : (
      <PayloadBody item={item} actions={actions} />
    )
  },
}

/**
 * The decision's words, per kind: the verb, and `Dismiss` for the other
 * way. A discovery card's dismissal is permanent for its space, so its
 * tooltip says so.
 */
type DecisionWords = {
  accept: string
  reject: string
  /** The dismiss button's tooltip; null for none. */
  rejectTitle: string | null
}

const DECIDE: DecisionWords = {
  accept: 'Accept',
  reject: 'Dismiss',
  rejectTitle: null,
}

const DISMISS_TITLE =
  'Dismiss for good: this domain is never suggested in this space again'

export function decisionWords(kind: SuggestionKind): DecisionWords {
  if (kind === 'add_record')
    return {
      accept: 'Add and file here',
      reject: 'Dismiss',
      rejectTitle: DISMISS_TITLE,
    }
  if (kind === 'file_record')
    return {
      accept: 'File here',
      reject: 'Dismiss',
      rejectTitle: DISMISS_TITLE,
    }
  if (kind === 'ledger_event')
    return {
      accept: 'Accept',
      reject: 'Dismiss',
      rejectTitle: null,
    }
  if (kind === 'refile_document')
    return {
      accept: 'Re-file',
      reject: 'Dismiss',
      rejectTitle: null,
    }
  if (kind === 'supersedes')
    return {
      accept: 'Mark as newer version',
      reject: 'Dismiss',
      rejectTitle: 'Dismiss for good: this pair is not suggested again',
    }
  return DECIDE
}

const isDiscovery = (kind: SuggestionKind) =>
  kind === 'add_record' || kind === 'file_record'

export function suggestionBodyFor(kind: SuggestionKind): SuggestionBody {
  return SUGGESTION_BODIES[kind] ?? PayloadBody
}

/** A kind with no sub-renderer: its payload, legible, in a mono block. */
export function PayloadBody({ item }: BodyProps): React.ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="field-label text-graphite">
        {SUGGESTION_KIND_WORD[item.kind]}
      </span>
      <pre className="max-h-48 overflow-auto border border-rule bg-bone px-2 py-1.5 mono text-micro text-graphite">
        {JSON.stringify(item.payload, null, 2)}
      </pre>
    </div>
  )
}

/**
 * A person the document named: the claim as the deck gave it, in
 * the patch body's label/value rows. Accepting resolves it — attach on an
 * email or LinkedIn match, else a new person, whose near-miss names land in
 * this same queue as a pair card.
 */
function IdentityBody({ claim }: { claim: IdentityPayload }) {
  const rows: Array<{ label: string; value: string; mono: boolean }> = [
    { label: 'Person', value: claim.name, mono: false },
    ...(claim.role === undefined
      ? []
      : [{ label: 'Role', value: claim.role, mono: false }]),
    ...(claim.email === undefined
      ? []
      : [{ label: 'Email', value: claim.email, mono: true }]),
    ...(claim.linkedin === undefined
      ? []
      : [{ label: 'LinkedIn', value: claim.linkedin, mono: true }]),
  ]
  return (
    <dl className="flex min-w-0 flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="truncate field-label text-graphite">{r.label}</dt>
          <dd
            className={cn(
              'min-w-0 truncate text-ui',
              r.mono && 'mono text-label',
            )}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A classification: the kind the document looks like, in the
 * patch body's label/value rows. Accepting sets the document's kind and
 * nothing else — a deck's Read deck button appears; nobody presses it here.
 */
function DocumentKindBody({ proposed }: { proposed: DocumentKindPayload }) {
  return (
    <dl className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="truncate field-label text-graphite">Looks like</dt>
        <dd className="min-w-0 truncate text-ui">
          {DOCUMENT_KIND_LABELS[proposed.kind]}
        </dd>
      </div>
      {proposed.confidence === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="truncate field-label text-graphite">Confidence</dt>
          <dd className="tabular min-w-0 truncate mono text-label">
            {Math.round(proposed.confidence * 100)}%
          </dd>
        </div>
      )}
    </dl>
  )
}

/**
 * A drafted note: its title and its body as the note will hold it,
 * citations and all. Markdown, read as text — the card is where a person
 * decides whether to keep it, and the editor is where it is formatted.
 */
function NoteDraftBody({ draft }: { draft: NotePayload }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="field-label text-graphite">Note</span>
      <span className="min-w-0 truncate text-ui font-medium">
        {draft.title}
      </span>
      <div className="max-h-48 overflow-auto border border-rule bg-bone px-2 py-1.5 text-label break-words whitespace-pre-wrap">
        {draft.markdown}
      </div>
    </div>
  )
}

/**
 * An action item: what the task will read, and its due date. Accepting
 * writes it through the task writer, by and for the accepter.
 */
function TaskBody({ title, due }: { title: string; due: string | null }) {
  return (
    <dl className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="truncate field-label text-graphite">Task</dt>
        <dd className="min-w-0 text-ui">{title}</dd>
      </div>
      {due === null ? null : (
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="truncate field-label text-graphite">Due</dt>
          <dd className="tabular min-w-0 truncate mono text-label">{due}</dd>
        </div>
      )}
    </dl>
  )
}

/**
 * A space tag: the space of the tree the record looks like it
 * belongs in, by its path, in the patch body's label/value rows. Accepting
 * tags the record into it (`source: ai`, this confidence, by the accepter).
 */
function SpaceTagBody({ proposed }: { proposed: SpaceTagPayload }) {
  return (
    <dl className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="truncate field-label text-graphite">Belongs in</dt>
        <dd className="min-w-0 truncate text-ui" title={proposed.label}>
          {proposed.label}
        </dd>
      </div>
      {proposed.confidence === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="truncate field-label text-graphite">Confidence</dt>
          <dd className="tabular min-w-0 truncate mono text-label">
            {Math.round(proposed.confidence * 100)}%
          </dd>
        </div>
      )}
    </dl>
  )
}

/**
 * A newer version: the document just filed and the one it would
 * supersede, each named once. Accepting links them; neither is deleted.
 */
function SupersedesBody({ pair }: { pair: SupersedesPayload }) {
  return (
    <p className="min-w-0 text-ui break-words">
      <span className="font-medium">{pair.newerName}</span>
      <span className="text-graphite"> is a newer version of </span>
      <span className="font-medium">{pair.olderName}</span>
    </p>
  )
}

/**
 * A storage-source document whose folder now points at another record: the
 * document and both records, each named once. Accepting moves the filing.
 */
function RefileBody({ move }: { move: RefileDocumentPayload }) {
  return (
    <p className="min-w-0 text-ui break-words">
      <span className="text-graphite">Re-file </span>
      <span className="font-medium">{move.documentName}</span>
      <span className="text-graphite"> from </span>
      <span className="font-medium">{move.fromName}</span>
      <span className="text-graphite"> to </span>
      <span className="font-medium">{move.toName}</span>
    </p>
  )
}

/** An ISO day as the tables print it, read as a calendar day. */
const ledgerDay = (date: string, today: string) =>
  formatDay(date.slice(0, 10), today) || date

/**
 * The parts of a ledger event's one line: the diff against the holding
 * first, then what would be appended. Exported for the Review test.
 */
export function ledgerEventParts(
  ledger: LedgerEventPayload,
  today: string,
): {
  moved: string | null
  proposed: string
  verb: string
} {
  const was = ledger.before.ownershipPct
  const now = ledger.after.ownershipPct
  const moved =
    now === null || was === now
      ? null
      : `ownership moved ${fmtPct(was)} → ${fmtPct(now)}`
  if (ledger.event === 'round') {
    const r = ledger.proposed
    const currency = r.currency ?? ledger.before.currency
    return {
      moved,
      proposed: [
        r.kind,
        r.raised === undefined ? null : ledgerMoney(r.raised, currency),
        ledgerDay(r.date, today),
      ]
        .filter((p) => p !== null)
        .join(' · '),
      verb: 'propose a round',
    }
  }
  const m = ledger.proposed
  const before =
    ledger.before.fairValue === null
      ? '—'
      : ledgerMoney(ledger.before.fairValue, ledger.before.currency)
  return {
    moved,
    proposed: `fair value ${before} → ${ledgerMoney(m.fairValue, m.currency)} · ${ledgerDay(m.date, today)}`,
    verb: 'propose a mark',
  }
}

/**
 * Money a model read: compact through `fmtMoney` when the currency is an
 * ISO code, else the bare figure — the accept-time validators refuse it.
 */
const ledgerMoney = (amount: number, currency: string | null) =>
  currency !== null && /^[A-Z]{3}$/.test(currency)
    ? fmtMoney(amount, currency, { compact: true })
    : formatNumber(amount, 0)

/**
 * A revised cap table read against the holding: what moved, what would be
 * appended, one line. Accepting appends it; nothing on the ledger changes.
 */
function LedgerEventBody({ ledger }: { ledger: LedgerEventPayload }) {
  const { today } = useClock()
  const { moved, proposed, verb } = ledgerEventParts(ledger, today)
  return (
    <p className="min-w-0 text-ui break-words">
      <span className="font-medium">{ledger.companyName}</span>
      <span className="text-graphite"> · </span>
      {moved === null ? null : (
        <>
          <span className="tabular">{moved}</span>
          <span className="text-graphite"> · </span>
        </>
      )}
      <span className="tabular">{proposed}</span>
      <span className="text-graphite">, {verb}</span>
    </p>
  )
}

/**
 * A company a watch found: its name, its domain, and the pages that
 * put it forward.
 */
function DiscoveryBody({
  name,
  domain,
  evidence,
}: {
  name: string
  domain: string
  evidence: ReadonlyArray<DiscoveryEvidence>
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="min-w-0 truncate text-ui font-medium">{name}</span>
      <span className="min-w-0 truncate mono text-label text-graphite">
        {domain}
      </span>
      {evidence.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-0.5" aria-label="Evidence">
          {evidence.map((e) => (
            <li key={e.url} className="min-w-0 truncate">
              <a
                href={e.url}
                target="_blank"
                rel="noreferrer"
                title={e.url}
                className="focus-ring mono text-micro text-graphite hover:text-foreground hover:underline"
              >
                {e.title ?? e.url}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * A proposed value, drawn the way the record table's cell for that type
 * reads: option chips for select/status, mono for measured things, the
 * checkbox square, a record claim by its name.
 */
export function ProposedValue({
  field: f,
}: {
  field: SuggestionField
}): React.ReactNode {
  const v = f.value
  const { today } = useClock()
  if (v === null || v === '') return <span className="text-graphite">—</span>
  switch (f.type) {
    case 'select':
    case 'status':
      return <OptionChip def={f} id={v} />
    case 'multi_select':
      return (
        <span className="flex min-w-0 flex-wrap gap-1">
          {(Array.isArray(v) ? v : [v]).map((id) => (
            <OptionChip key={String(id)} def={f} id={id} />
          ))}
        </span>
      )
    case 'checkbox': {
      const on = v === true
      return (
        <span
          role="img"
          aria-label={on ? 'Checked' : 'Unchecked'}
          className={checkboxClasses({ checked: on })}
        >
          {on ? <Check className="size-2.5" strokeWidth={3} /> : null}
        </span>
      )
    }
    case 'date':
      return (
        <span className="tabular mono">
          {typeof v === 'string' ? formatDay(v, today) || v : String(v)}
        </span>
      )
    case 'number':
      return (
        <span className="tabular mono">
          {typeof v === 'number' || typeof v === 'string'
            ? formatNumber(v, f.options?.precision)
            : JSON.stringify(v)}
        </span>
      )
    case 'currency':
      return (
        <span className="tabular mono">
          {typeof v === 'number'
            ? fmtMoney(v, f.options?.code ?? 'USD')
            : JSON.stringify(v)}
        </span>
      )
    case 'rating':
      return (
        <span className="tabular mono">
          {typeof v === 'number' ? `${v}/${f.options?.max ?? 5}` : String(v)}
        </span>
      )
    case 'record_reference': {
      // Proposed as an identity claim `{name, domain?}`, never an id.
      const name =
        typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string'
          ? v.name
          : JSON.stringify(v)
      return <span className="truncate">{name}</span>
    }
    case 'domain':
    case 'email':
    case 'url':
    case 'phone':
      return (
        <span className="truncate mono text-label">
          {typeof v === 'string' ? v : JSON.stringify(v)}
        </span>
      )
    default:
      return (
        <span className="min-w-0 break-words">
          {typeof v === 'string' ? v : JSON.stringify(v)}
        </span>
      )
  }
}

/**
 * One suggestion: the mono line of what and from where, what is proposed,
 * why — and the decision on a bone foot. Pure over its props, so the
 * renderer map is testable without a router.
 * - A field change draws its grid (`Proposed · Current · Confidence ·
 *   Source`); every other kind draws its body.
 */
export function SuggestionEntry({
  item,
  pending,
  onAccept,
  onReject,
  actions = null,
  failure = null,
}: {
  item: SuggestionItem
  pending: boolean
  onAccept: () => void
  onReject: () => void
  /** The field rows' bulk affordances; omitted, they draw read-only. */
  actions?: FieldActions | null
  /** The last batch's refusal for the suggestion as a whole (not a patch). */
  failure?: string | null
}): React.ReactNode {
  const { today } = useClock()
  const Body = suggestionBodyFor(item.kind)
  const words = decisionWords(item.kind)
  const grid = item.kind === 'attribute_patch' && item.fields !== null
  // A newer-version body already names both documents its refs cite; a
  // grid prints the first citation in its Source lane.
  const citations =
    item.kind === 'supersedes' && readSupersedesPayload(item.payload) !== null
      ? []
      : grid
        ? item.citations.slice(1)
        : item.citations
  return (
    <li
      data-suggestion
      className="flex flex-col border-b border-rule last:border-b-0"
    >
      <div className="flex flex-col gap-3 px-5 pt-3 pb-4">
        <p data-suggestion-meta className="mono text-micro text-graphite">
          {suggestionMeta(item, today)}
        </p>
        {grid && item.fields !== null ? (
          <FieldGrid item={item} fields={item.fields} actions={actions} />
        ) : (
          <Body item={item} actions={actions} />
        )}
        {failure ? (
          <p role="alert" className="text-label text-destructive">
            {failure}
          </p>
        ) : null}
        {item.rationale === null ? null : (
          <p className="text-ui text-graphite">{item.rationale}</p>
        )}
        {/* A proposal from outside the app says which door it came
            through, so it never reads as one of the app's own. */}
        {item.origin.via === 'mcp' ? (
          <p className="text-label text-graphite">
            Proposed over MCP by token{' '}
            <span className="mono">{item.origin.token}</span>
          </p>
        ) : item.origin.via === 'integration' && item.source === null ? (
          <p className="text-label text-graphite">Proposed by an integration</p>
        ) : null}
        {citations.length > 0 ? (
          <ul className="flex flex-wrap gap-1" aria-label="Citations">
            {citations.map((c) => (
              <li
                key={c.ref}
                title={c.ref}
                className={cn(
                  'max-w-full truncate border border-rule bg-paper px-1.5 py-0.5 mono text-micro text-graphite',
                  c.missing && 'italic',
                )}
              >
                {c.label}
              </li>
            ))}
          </ul>
        ) : null}
        {/* The run that proposed it, opened in Settings → Usage. A
            plain anchor, so the entry stays pure over its props. */}
        {item.runId === null ? null : (
          <a
            href={usageRunHref(item.runId)}
            className="focus-ring self-start mono text-micro text-graphite hover:text-foreground hover:underline"
          >
            Produced by this run ›
          </a>
        )}
      </div>
      <div
        data-suggestion-foot
        className="flex min-h-11 items-center justify-end gap-2 border-t border-rule bg-bone px-5 py-2"
      >
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onReject}
          {...(words.rejectTitle === null ? {} : { title: words.rejectTitle })}
        >
          {words.reject}
        </Button>
        <Button size="sm" disabled={pending} onClick={onAccept}>
          {words.accept}
        </Button>
      </div>
    </li>
  )
}

/**
 * The entry's one mono line: what it changes, who proposed it, the day —
 * `Funding stage · via Apollo · 14 Oct`.
 */
export function suggestionMeta(item: SuggestionItem, today: string): string {
  const what =
    item.kind === 'attribute_patch' && item.fields !== null
      ? item.fields.map((f) => f.name).join(', ')
      : SUGGESTION_KIND_WORD[item.kind]
  return [
    what,
    item.source === null ? null : `via ${item.source}`,
    formatDay(item.createdAt, today),
  ]
    .filter((p) => p !== null && p !== '')
    .join(' · ')
}

/** A confidence in `0..1` as the grid prints it: `82%`. */
const percent = (c: number | null): string =>
  c === null ? '—' : `${Math.round(c * 100)}%`

/** The grid's lane heads, sans 12 graphite. */
const GRID_HEADS = ['Proposed', 'Current', 'Confidence', 'Source'] as const

/**
 * A field change as a grid: one row per field — the proposed value, what the
 * record holds now, the proposer's confidence and the first source cited —
 * with Accept column at the row's end when the card offers it.
 */
function FieldGrid({
  item,
  fields,
  actions,
}: {
  item: SuggestionItem
  fields: Array<SuggestionField>
  actions: FieldActions | null
}) {
  const source = item.citations.at(0)?.label ?? item.source ?? '—'
  // One field names itself in the mono line; several get a Field lane.
  const named = fields.length > 1
  const cols = cn(
    'grid min-w-0 items-center gap-x-4',
    named
      ? 'grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_5rem_minmax(0,1.2fr)]'
      : 'grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_5rem_minmax(0,1.2fr)]',
  )
  return (
    <div data-field-grid className="flex min-w-0 flex-col">
      <div
        className={cn(
          cols,
          'h-7 border-b border-hairline text-label text-graphite',
        )}
      >
        {named ? <span>Field</span> : null}
        {GRID_HEADS.map((h) => (
          <span key={h} className="truncate">
            {h}
          </span>
        ))}
      </div>
      {fields.map((f) => {
        const failure = actions?.failureOf(item.id, f.slug) ?? null
        return (
          <div key={f.slug} className="flex flex-col border-b border-rule">
            <div className={cn(cols, 'min-h-9 py-1.5 text-ui')}>
              {named ? (
                <span className="truncate text-label text-graphite">
                  {f.name}
                </span>
              ) : null}
              <span className="flex min-w-0 items-center">
                <ProposedValue field={f} />
              </span>
              <span className="flex min-w-0 items-center text-graphite">
                <ProposedValue field={{ ...f, value: f.current }} />
              </span>
              <span className="tabular mono text-label">
                {percent(f.confidence)}
              </span>
              <span
                className="truncate mono text-micro text-graphite"
                title={source}
              >
                {source}
              </span>
            </div>
            {actions ? (
              <div className="flex justify-end pb-1.5">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={actions.pending}
                  title={`Accept ${f.name} on every record that proposes it`}
                  onClick={() => actions.onAcceptColumn(f)}
                >
                  <CheckCheck className="size-3" strokeWidth={2} />
                  Accept column
                </Button>
              </div>
            ) : null}
            {failure ? (
              <p role="alert" className="pb-1.5 text-label text-destructive">
                {failure}
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** The record the card is about, by its serif name; plain when it has no page. */
function RecordName({ record }: { record: SuggestionRow['record'] }) {
  const href = recordPath(record)
  return (
    <h2 className="min-w-0 truncate font-serif text-lg leading-5.5 font-semibold">
      {href ? (
        <Link to={href} className="focus-ring hover:underline">
          {record.name}
        </Link>
      ) : (
        record.name
      )}
    </h2>
  )
}

/**
 * The toast a batch ends with. "4 applied, 1 failed"; an all-failed batch
 * says nothing was applied, so an unchanged queue never reads as success.
 */
export function batchSummary(outcomes: ReadonlyArray<BatchOutcome>): string {
  const applied = outcomes.filter((o) => o.ok).length
  const failed = outcomes.length - applied
  if (outcomes.length === 0) return 'Nothing left to accept'
  if (applied === 0) return `Nothing applied — ${failed} failed, all still open`
  return failed === 0
    ? `${applied} applied`
    : `${applied} applied, ${failed} failed`
}

/** Key for one item's refusal: the suggestion, and its field if it had one. */
const failureKey = (suggestionId: string, slug?: string) =>
  slug === undefined ? suggestionId : `${suggestionId}:${slug}`

/**
 * The card header's bulk verb. Pure over its props, like the entry, so the
 * route test can render it without a router.
 */
export function AcceptAllButton({
  pending,
  onClick,
}: {
  pending: boolean
  onClick: () => void
}): React.ReactNode {
  return (
    <Button
      size="xs"
      className="ml-auto"
      disabled={pending}
      title="Accept every open suggestion on this record, field by field"
      onClick={onClick}
    >
      <CheckCheck className="size-3" strokeWidth={2} />
      Accept all
    </Button>
  )
}

export function SuggestionCard({ card }: { card: SuggestionRow }) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  // The last batch's refusals, by `failureKey` — drawn inline under the
  // field (or the suggestion) they belong to, until the next batch.
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  )
  const n = card.suggestions.length

  async function runBatch(run: () => Promise<Array<BatchOutcome>>) {
    setPending('batch')
    try {
      const outcomes = await run()
      setFailures(
        new Map(
          outcomes.flatMap((o) =>
            o.ok ? [] : [[failureKey(o.suggestionId, o.slug), o.message]],
          ),
        ),
      )
      const summary = batchSummary(outcomes)
      if (outcomes.some((o) => o.ok)) toast(summary)
      else toast.error(summary)
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setPending(null)
    }
  }

  const actions: FieldActions = {
    pending: pending !== null,
    failureOf: (id, slug) => failures.get(failureKey(id, slug)) ?? null,
    onAcceptColumn: (f) =>
      void runBatch(() =>
        acceptSuggestionColumn({ data: { attributeSlug: f.slug } }),
      ),
  }

  async function decide(id: string, verb: 'accept' | 'reject') {
    setPending(id)
    try {
      if (verb === 'accept') await acceptSuggestion({ data: { id } })
      else await rejectSuggestion({ data: { id } })
      toast(
        verb === 'accept'
          ? `Accepted on ${card.record.name}`
          : 'Dismissed — will not be suggested again',
      )
      void router.invalidate()
    } catch (err) {
      // The validator's own sentence; the row stays for another look.
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setPending(null)
    }
  }

  return (
    <li
      data-suggestion-card
      className="flex flex-col border border-hairline bg-paper"
    >
      <div className="flex min-h-11 items-center gap-3 border-b border-hairline px-5 py-2.5">
        {/* A captured page's card is headed by the page. */}
        {card.page === null ? (
          <RecordName record={card.record} />
        ) : (
          <CapturedPageHeading page={card.page} />
        )}
        {n > 1 ? (
          <span className="tabular mono text-micro text-graphite">{n}</span>
        ) : null}
        {/* Discovery cards and newer versions are decided one by one. */}
        {card.suggestions.every(
          (s) => isDiscovery(s.kind) || s.kind === 'supersedes',
        ) ? null : (
          <AcceptAllButton
            pending={pending !== null}
            onClick={() =>
              void runBatch(() =>
                acceptSuggestionsForRecord({
                  data: { entityId: card.record.id },
                }),
              )
            }
          />
        )}
      </div>
      <ul className="flex flex-col">
        {card.suggestions.map((s) => (
          <SuggestionEntry
            key={s.id}
            item={s}
            pending={pending !== null}
            onAccept={() => void decide(s.id, 'accept')}
            onReject={() => void decide(s.id, 'reject')}
            actions={actions}
            failure={failures.get(failureKey(s.id)) ?? null}
          />
        ))}
      </ul>
    </li>
  )
}
