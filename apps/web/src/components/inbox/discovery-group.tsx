import { useRouter } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'
import { useCallback, useEffect, useReducer, useState } from 'react'
import { toast } from 'sonner'
import { PluginMark } from '#/components/integrations/integration-ledger'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import {
  readAddRecordPayload,
  readFileRecordPayload,
} from '@spaces/core/ai/discovery'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import { acceptSuggestion, rejectSuggestion } from '#/lib/server-fns'
import type { DiscoveryRow, SuggestionItem } from '#/lib/server-fns'
import type { JobStatusRow } from '#/lib/integrations/job-status'
import {
  decodeInit,
  decodeStatus,
  emptyJobStatus,
  jobStatusEvent,
  jobStatusInit,
} from '#/lib/integrations/job-status-view'
import type { JobStatusState } from '#/lib/integrations/job-status-view'
import {
  AFTER_WORDS,
  enrichPhase,
  evidenceLabel,
  foundByLine,
  settled,
} from '#/lib/inbox/discovery-view'
import type { AfterState } from '#/lib/inbox/discovery-view'
import { decisionWords } from './suggestion-card'

/**
 * A space's discovery cards in Review (R1, P9): a bone head — the space's
 * path, `via` each plugin that found them, the mono count — over one row per
 * company, each decided on its own. (D72, D77)
 * - Accepting "add X?" keeps the row in place showing its after-state while
 *   `entity.created` fans out, then lets the queue drop it.
 * - Dismiss's tooltip is where "permanent for this space" is said.
 */

/** A discovery card's fields as the row draws them; null for a bad payload. */
export function discoveryCardOf(item: SuggestionItem) {
  const card =
    item.kind === 'add_record'
      ? readAddRecordPayload(item.payload)
      : item.kind === 'file_record'
        ? readFileRecordPayload(item.payload)
        : null
  return card === null
    ? null
    : {
        name: card.name,
        domain: card.domain,
        evidence: card.evidence,
        watches: card.watchIds.length,
      }
}

/** The group's head. Pure over its props. */
export function DiscoveryHead({ group }: { group: DiscoveryRow }) {
  const n = group.suggestions.length
  return (
    <SectionHead
      title={
        <a
          href={`/spaces/${group.space.id}`}
          title={group.space.path}
          className="focus-ring hover:underline"
        >
          {group.space.path}
        </a>
      }
      count={String(n)}
      action={
        group.via.length === 0 ? null : (
          <span className="flex items-center gap-2">
            via
            {group.via.map((name) => (
              <span key={name} className="flex items-center gap-1.5">
                <PluginMark name={name} />
                <span className="text-foreground">{name}</span>
              </span>
            ))}
          </span>
        )
      }
    />
  )
}

/** One company: name, domain, evidence chips, the two verbs or the after-state. */
export function DiscoveryEntry({
  item,
  pending,
  after,
  onAccept,
  onDismiss,
}: {
  item: SuggestionItem
  pending: boolean
  /** Set once accepted: the verbs give way to it. */
  after: AfterState | null
  onAccept: () => void
  onDismiss: () => void
}) {
  const card = discoveryCardOf(item)
  const words = decisionWords(item.kind)
  const found = card === null ? null : foundByLine(card.watches)
  return (
    <li className="flex min-h-10 flex-col gap-2 border-b border-rule px-3 py-2 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 truncate text-ui font-medium">
            {card?.name ?? 'Unreadable card'}
          </span>
          {card === null ? null : (
            <span className="shrink-0 mono text-label text-graphite">
              {card.domain}
            </span>
          )}
          {found === null ? null : (
            <span className="shrink-0 mono text-micro text-graphite">
              {found}
            </span>
          )}
        </div>
        {card !== null &&
        (card.evidence.length > 0 || item.citations.length > 0) ? (
          <ul className="flex flex-wrap gap-1" aria-label="Evidence">
            {card.evidence.map((e) => (
              <li key={e.url} className="max-w-full">
                <a
                  href={e.url}
                  target="_blank"
                  rel="noreferrer"
                  title={e.url}
                  className="focus-ring block max-w-full truncate border border-rule bg-paper px-1.5 py-0.5 mono text-micro text-graphite hover:text-foreground"
                >
                  {evidenceLabel(e)}
                </a>
              </li>
            ))}
            {item.citations.map((c) => (
              <li
                key={c.ref}
                title={c.ref}
                className="max-w-full truncate border border-rule bg-bone px-1.5 py-0.5 mono text-micro text-graphite"
              >
                {c.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {after !== null ? (
        <span role="status" className="shrink-0 mono text-micro text-graphite">
          {AFTER_WORDS[after]}
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={onDismiss}
            {...(words.rejectTitle === null
              ? {}
              : { title: words.rejectTitle })}
          >
            <X className="size-3" strokeWidth={2} />
            {words.reject}
          </Button>
          <Button size="xs" disabled={pending} onClick={onAccept}>
            <Check className="size-3" strokeWidth={2} />
            {words.accept}
          </Button>
        </div>
      )}
    </li>
  )
}

/** How long a new record's stream may stay silent before "Added" stands alone. */
const QUIET_MS = 20_000

type StreamAction =
  | { kind: 'init'; rows: ReadonlyArray<JobStatusRow> }
  | { kind: 'status'; event: JobStatusEvent }

const reduce = (state: JobStatusState, action: StreamAction) =>
  action.kind === 'init'
    ? jobStatusInit(state, action.rows)
    : jobStatusEvent(state, action.event)

/** The new record's enrich state, off its job-status stream. (D64) */
function useEnrichPhase(entityId: string | null): AfterState | null {
  const [state, dispatch] = useReducer(reduce, emptyJobStatus)
  const [quiet, setQuiet] = useState(false)
  useEffect(() => {
    if (entityId === null) return
    const es = new EventSource(
      `/api/job-status/${encodeURIComponent(entityId)}`,
    )
    es.addEventListener('init', (message) => {
      const rows = decodeInit(message.data)
      if (rows !== null) dispatch({ kind: 'init', rows })
    })
    es.addEventListener('status', (message) => {
      const event = decodeStatus(message.data)
      if (event !== null) dispatch({ kind: 'status', event })
    })
    const timer = setTimeout(() => setQuiet(true), QUIET_MS)
    return () => {
      clearTimeout(timer)
      es.close()
    }
  }, [entityId])
  return entityId === null ? null : enrichPhase(state, quiet)
}

/** One accepted card's after-state, held until it settles. */
function AcceptedEntry({
  item,
  added,
  onSettled,
}: {
  item: SuggestionItem
  /** The company the accept created; null when nothing was born. */
  added: string | null
  onSettled: (id: string) => void
}) {
  const phase = useEnrichPhase(added)
  const after: AfterState = phase ?? 'filed'
  const done = settled(after)
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => onSettled(item.id), 2_000)
    return () => clearTimeout(timer)
  }, [done, onSettled, item.id])
  return (
    <DiscoveryEntry
      item={item}
      pending
      after={after}
      onAccept={() => {}}
      onDismiss={() => {}}
    />
  )
}

export function DiscoveryGroup({ group }: { group: DiscoveryRow }) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  // Accepted cards, by suggestion id, with the company each one created —
  // kept here so a refresh for another row does not cut the after-state short.
  const [accepted, setAccepted] = useState<
    ReadonlyMap<string, { item: SuggestionItem; added: string | null }>
  >(() => new Map())
  // A settled after-state has been shown once: the queue drops the card.
  const settle = useCallback(
    (id: string) => {
      setAccepted((m) => {
        const rest = new Map(m)
        rest.delete(id)
        return rest
      })
      void router.invalidate()
    },
    [router],
  )
  const live = new Set(group.suggestions.map((s) => s.id))

  async function accept(item: SuggestionItem) {
    setPending(item.id)
    try {
      const out = await acceptSuggestion({ data: { id: item.id } })
      setAccepted((m) =>
        new Map(m).set(item.id, {
          item,
          added:
            out.added !== null && out.added.created ? out.added.entityId : null,
        }),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setPending(null)
    }
  }

  async function dismiss(item: SuggestionItem) {
    setPending(item.id)
    try {
      await rejectSuggestion({ data: { id: item.id } })
      toast('Dismissed')
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setPending(null)
    }
  }

  return (
    <li className="flex flex-col border border-hairline bg-paper shadow-solid">
      <DiscoveryHead group={group} />
      <ul className="flex flex-col">
        {group.suggestions.map((s) => {
          const held = accepted.get(s.id)
          return held === undefined ? (
            <DiscoveryEntry
              key={s.id}
              item={s}
              pending={pending !== null}
              after={null}
              onAccept={() => void accept(s)}
              onDismiss={() => void dismiss(s)}
            />
          ) : (
            <AcceptedEntry
              key={s.id}
              item={s}
              added={held.added}
              onSettled={settle}
            />
          )
        })}
        {/* Accepted, and already gone from the queue another refresh read. */}
        {[...accepted.values()]
          .filter(({ item }) => !live.has(item.id))
          .map(({ item, added }) => (
            <AcceptedEntry
              key={item.id}
              item={item}
              added={added}
              onSettled={settle}
            />
          ))}
      </ul>
    </li>
  )
}
