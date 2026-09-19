import type { IdentityOutcome } from '../entities/resolve'

/**
 * The one sentence a losing identity write owes the operator (SPA-97).
 *
 * objects-7 made the collision correct and invisible: the value lands, the
 * claim goes to whoever held it, and the only evidence is a row in a queue
 * nobody was looking at. This is the other half — "a conflict is never
 * silent" (CONTEXT.md, Machine-write design).
 *
 * It copies the precedent exactly rather than inventing an interaction:
 * `addCompanyDomain`'s toast on the company rail is title plus
 * `description`, prose only. **No action button** — `DESIGN.md` §5's
 * Micro-interactions sheet carries four proposals and a toast action is not
 * among them, so the conservative reading is the shipped one: the inbox is
 * named in the sentence and reached the way every other surface reaches it.
 *
 * Pure on purpose: the two editing surfaces call it with what their server
 * fn just returned, and the whole "which toast, if any" decision is one
 * testable function instead of two copies of a condition.
 */
export type CollisionToast = { title: string; description: string }

/** Exactly what `updateRecord` / `createObjectRecord` hand back. */
export type IdentityReport = {
  identity: Record<string, IdentityOutcome>
  identityValues: Record<string, string>
}

/**
 * `suggested_duplicate` is the only outcome anyone is told about: `added` is
 * the write working, `already_own` is a no-op re-assertion of a claim this
 * record already holds, and `released` is a clear the operator just made on
 * purpose. Announcing any of those three would be the instrument narrating
 * itself.
 *
 * `singular` is the object's noun verbatim, cased as the operator wrote it —
 * an object named "LP" must not read "another lp", the same reason the pair
 * card's heading does not lowercase it.
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
      description: 'Both records exist. Review the pair in the review inbox.',
    }
  }
  return null
}
