import type { IdentityOutcome } from '@spaces/core/writes/entities/resolve'

/**
 * The one sentence a losing identity write owes the operator: the value
 * lands, the claim stays with its holder, and a conflict is never silent.
 * - Title plus `description`, prose only. No action button: the inbox is
 *   named in the sentence and reached the usual way.
 * - Pure, so both editing surfaces share one testable "which toast" decision.
 */
export type CollisionToast = { title: string; description: string }

/** Exactly what `updateRecord` / `createObjectRecord` hand back. */
export type IdentityReport = {
  identity: Record<string, IdentityOutcome>
  identityValues: Record<string, string>
}

/**
 * Only `suggested_duplicate` is announced; `added`, `already_own` and
 * `released` are the write working as asked.
 * `singular` is the object's noun verbatim, as the operator cased it — an
 * object named "LP" must not read "another lp".
 */
export function collisionToast(
  report: IdentityReport,
  singular: string,
): CollisionToast | null {
  // Walked from the values side, not the outcome side: the normalized value
  // is what the unique index compared and the only thing the sentence can
  // name, so a slug with no value has nothing to say — which is exactly the
  // `released` case, where the record asserted nothing at all.
  for (const [slug, value] of Object.entries(report.identityValues)) {
    if (report.identity[slug] !== 'suggested_duplicate') continue
    return {
      title: `Another ${singular} claims ${value}`,
      description: 'Both records exist. The pair is waiting in Review.',
    }
  }
  return null
}
