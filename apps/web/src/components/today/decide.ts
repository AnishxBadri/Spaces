import { toast } from 'sonner'
import { columnHoldKey } from '#/components/inbox/suggestion-card'
import { heldDecisions } from '#/lib/held-decisions'
import {
  acceptSuggestion,
  acceptSuggestionColumn,
  addProposedOption,
  dismissDuplicate,
  rejectSuggestion,
} from '#/lib/server-fns'
import { acceptAllShortfall } from '#/lib/today/proposals'
import type { ProposalGroupOf, ProposalLeaf } from '#/lib/today/proposals'

/**
 * Today's decisions, each held: the row leaves, the toast holds Undo, and
 * the write runs when the hold runs out. Keyed as Review keys them, so a
 * decision held on one surface is hidden on the other.
 */

/** Decide one row: its primary or Dismiss. A pair's primary is Compare, a link. */
export function decideProposal(
  leaf: ProposalLeaf,
  verb: 'accept' | 'dismiss',
): void {
  const t = leaf.target
  if (t.kind === 'duplicate') {
    if (verb === 'accept') return
    heldDecisions.hold(t.pair.id, {
      decision: { verb: 'dismiss-duplicate', candidateId: t.pair.id },
      label: t.dismissed,
      commit: () => dismissDuplicate({ data: { candidateId: t.pair.id } }),
    })
    return
  }
  const id = t.item.id
  if (verb === 'dismiss') {
    heldDecisions.hold(id, {
      decision: { verb: 'dismiss', id },
      label: t.dismissed,
      commit: () => rejectSuggestion({ data: { id } }),
    })
    return
  }
  const option = t.option
  if (option !== null) {
    heldDecisions.hold(id, {
      decision: { verb: 'add-option', suggestionId: id, label: option.label },
      label: t.accepted,
      commit: () =>
        addProposedOption({ data: { suggestionId: id, label: option.label } }),
    })
    return
  }
  heldDecisions.hold(id, {
    decision: { verb: 'accept', id },
    label: t.accepted,
    commit: () => acceptSuggestion({ data: { id } }),
  })
}

/**
 * A column run's Accept all: the run's field on every record it proposed it
 * for. A shortfall speaks again once the write lands, with the way to Review.
 */
export function acceptRun(
  run: Extract<ProposalGroupOf, { kind: 'column_run' }>,
  openReview: () => void,
): void {
  const slug = run.attributeSlug
  if (slug === null) return
  heldDecisions.hold(columnHoldKey(slug, run.runId), {
    decision: { verb: 'accept-column', attributeSlug: slug, runId: run.runId },
    label: `${String(run.taken)} accepted on ${run.title}`,
    commit: async () => {
      const outcomes = await acceptSuggestionColumn({
        data: { attributeSlug: slug, runId: run.runId },
      })
      const short = acceptAllShortfall(outcomes)
      if (short !== null)
        toast.error(short, {
          action: { label: 'Open in Review', onClick: openReview },
        })
    },
  })
}
