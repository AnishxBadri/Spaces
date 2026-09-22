import { useRouter } from '@tanstack/react-router'
import { Boxes, Check, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { OptionChip } from '#/components/attributes/value-editor'
import { KIND_ICONS } from '#/components/editor/mention'
import { ChipLink } from '#/components/table/cells'
import { Button } from '#/components/ui/button'
import { checkboxClasses } from '#/components/ui/checkbox'
import { formatDate, formatNumber } from '@spaces/core/format'
import { fmtMoney } from '@spaces/core/portfolio/format'
import { acceptSuggestion, rejectSuggestion } from '#/lib/server-fns'
import type {
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
 * later lanes (note, ledger_event, identity, document_kind) add a body here,
 * not a page.
 */

/** The word a person reads for each kind. Exhaustive by type. */
export const SUGGESTION_KIND_WORD: Record<SuggestionKind, string> = {
  attribute_patch: 'Field change',
  note: 'Note',
  ledger_event: 'Ledger event',
  identity: 'Identity',
  document_kind: 'Document type',
}

type BodyProps = { item: SuggestionItem }
type SuggestionBody = (props: BodyProps) => React.ReactNode

/**
 * One body per kind that has a sub-renderer. A missing key is the case
 * `PayloadBody` exists for, never a crash.
 */
const SUGGESTION_BODIES: Partial<Record<SuggestionKind, SuggestionBody>> = {
  attribute_patch: ({ item }) =>
    item.fields ? (
      <PatchBody fields={item.fields} />
    ) : (
      <PayloadBody item={item} />
    ),
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

function PatchBody({ fields }: { fields: Array<SuggestionField> }) {
  return (
    <dl className="flex min-w-0 flex-col gap-2">
      {fields.map((f) => (
        <div key={f.slug} className="flex min-w-0 flex-col gap-0.5">
          <dt className="field-label text-graphite">{f.name}</dt>
          <dd className="flex min-w-0 items-center text-ui">
            <ProposedValue field={f} />
          </dd>
        </div>
      ))}
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
}: {
  item: SuggestionItem
  pending: boolean
  onAccept: () => void
  onReject: () => void
}): React.ReactNode {
  const Body = suggestionBodyFor(item.kind)
  return (
    <li className="flex flex-col gap-3 border-b border-rule px-5 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-5">
      <div className="min-w-0 sm:w-56 sm:shrink-0">
        <Body item={item} />
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

export function SuggestionCard({ card }: { card: SuggestionRow }) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const n = card.suggestions.length

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
      </div>
      <ul className="flex flex-col">
        {card.suggestions.map((s) => (
          <SuggestionEntry
            key={s.id}
            item={s}
            pending={pending !== null}
            onAccept={() => void decide(s.id, 'accept')}
            onReject={() => void decide(s.id, 'reject')}
          />
        ))}
      </ul>
    </li>
  )
}
