import { useRouter } from '@tanstack/react-router'
import { Boxes, Check, CheckCheck, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { OptionChip } from '#/components/attributes/value-editor'
import { KIND_ICONS } from '#/components/editor/mention'
import { ChipLink } from '#/components/table/cells'
import { Button } from '#/components/ui/button'
import { checkboxClasses } from '#/components/ui/checkbox'
import { readIdentityPayload } from '@spaces/core/ai/identity'
import type { IdentityPayload } from '@spaces/core/ai/identity'
import { readNotePayload } from '@spaces/core/ai/note'
import type { NotePayload } from '@spaces/core/ai/note'
import { readSpaceTagPayload } from '@spaces/core/ai/space-tag'
import type { SpaceTagPayload } from '@spaces/core/ai/space-tag'
import { readDocumentKindPayload } from '@spaces/core/ai/document-kind'
import type { DocumentKindPayload } from '@spaces/core/ai/document-kind'
import { DOCUMENT_KIND_LABELS } from '@spaces/core/documents'
import { formatDate, formatNumber } from '@spaces/core/format'
import { fmtMoney } from '@spaces/core/portfolio/format'
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
 * The suggestion card (SPA-98, spec-ai-substrate.md §10) — every open
 * suggestion on one record, one row per suggestion, each accepted or
 * rejected on its own. The card is the pair card's container (the queue
 * precedent, `docs/design-contract.md` §3); the row is rationale, citations
 * and a decision.
 *
 * Generic over `suggestion.kind`: a kind with a body in `SUGGESTION_BODIES`
 * draws it, every other kind prints its payload in the same row shape. The
 * later lanes (note, ledger_event, document_kind) add a body here, not a
 * page; `identity` has one (SPA-105).
 */

/** The word a person reads for each kind. Exhaustive by type. */
export const SUGGESTION_KIND_WORD: Record<SuggestionKind, string> = {
  attribute_patch: 'Field change',
  note: 'Note',
  ledger_event: 'Ledger event',
  identity: 'Identity',
  document_kind: 'Document type',
  space_tag: 'Space',
}

/**
 * What a field row can do beyond showing its value (SPA-110): accept its
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
  attribute_patch: ({ item, actions }) =>
    item.fields ? (
      <PatchBody
        suggestionId={item.id}
        fields={item.fields}
        actions={actions}
      />
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
}

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
 * A person the document named (SPA-105): the claim as the deck gave it, in
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
 * A classification (SPA-62): the kind the document looks like, in the
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
 * A drafted note (SPA-66): its title and its body as the note will hold it,
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
 * A space tag (SPA-103): the space of the tree the record looks like it
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

function PatchBody({
  suggestionId,
  fields,
  actions,
}: {
  suggestionId: string
  fields: Array<SuggestionField>
  actions: FieldActions | null
}) {
  return (
    <dl className="flex min-w-0 flex-col gap-2">
      {fields.map((f) => {
        const failure = actions?.failureOf(suggestionId, f.slug) ?? null
        return (
          <div key={f.slug} className="flex min-w-0 flex-col gap-0.5">
            <dt className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate field-label text-graphite">
                {f.name}
              </span>
              {actions ? (
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
              ) : null}
            </dt>
            <dd className="flex min-w-0 items-center text-ui">
              <ProposedValue field={f} />
            </dd>
            {failure ? (
              <dd role="alert" className="text-label text-destructive">
                {failure}
              </dd>
            ) : null}
          </div>
        )
      })}
    </dl>
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
          {typeof v === 'string' ? formatDate(v) || v : String(v)}
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
 * One suggestion: what is proposed, why, from what — and the decision. Pure
 * over its props, so the renderer map is testable without a router.
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
  const Body = suggestionBodyFor(item.kind)
  return (
    <li className="flex flex-col gap-3 border-b border-rule px-5 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-5">
      <div className="flex min-w-0 flex-col gap-1 sm:w-64 sm:shrink-0">
        <Body item={item} actions={actions} />
        {failure ? (
          <p role="alert" className="text-label text-destructive">
            {failure}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-ui text-graphite">
          {item.rationale ?? 'No rationale given.'}
        </p>
        {item.citations.length > 0 ? (
          <ul className="flex flex-wrap gap-1" aria-label="Citations">
            {item.citations.map((c) => (
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
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={onReject}
        >
          <X className="size-3" strokeWidth={2} />
          Reject
        </Button>
        <Button size="xs" disabled={pending} onClick={onAccept}>
          <Check className="size-3" strokeWidth={2} />
          Accept
        </Button>
      </div>
    </li>
  )
}

/** The record the card is about, as a chip; plain text when it has no page. */
function RecordChip({ record }: { record: SuggestionRow['record'] }) {
  const Icon = KIND_ICONS[record.kind] ?? Boxes
  const href = recordPath(record)
  return href ? (
    <ChipLink to={href} icon={Icon} label={record.name} />
  ) : (
    <span className="flex min-w-0 items-center gap-1 border border-rule bg-paper px-1.5 py-0.5 text-label font-medium">
      <Icon className="size-2.5 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{record.name}</span>
    </span>
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
          : 'Rejected — will not be suggested again',
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
    <li className="flex flex-col border border-hairline bg-paper shadow-[3px_3px_0_0_var(--hairline)]">
      <div className="flex min-h-11 items-center gap-3 border-b border-hairline px-5 py-2.5">
        <RecordChip record={card.record} />
        <span className="label-caps text-graphite">Suggestions</span>
        <span className="mono text-micro text-graphite">{n}</span>
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
