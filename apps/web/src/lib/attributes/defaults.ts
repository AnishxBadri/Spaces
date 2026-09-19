import { Effect } from 'effect'
import { setValuesEffect } from './values'
import type {
  Actor,
  AttributeValidationError,
  EntityNotFound,
  EventSource,
  SetValuesResult,
  ValuesWriteFailed,
} from './values'

export {
  addIsoDuration,
  isIsoDuration,
  resolveDefault,
  validateDefault,
} from '@spaces/core/attributes/default-values'

/**
 * Default values (spec §4, grilled 2026-09). A default is a standing human
 * instruction — the email-filter analogy, not machine opinion — so it fires
 * on every creation path: dialog, composer, import, sync. Three rules:
 *
 * - Fill blanks only. A supplied value always wins (imports: mapped columns
 *   win, unmapped ones default).
 * - `current-user` resolves only when a human is present; machine creation
 *   skips it silently, and the record lands ownerless, which is true.
 * - Written through setValues with the true actor, door `default`, so the
 *   history says who was there when the value appeared.
 */

export type BirthValuesInput = {
  entityId: string
  actor: Actor
  /** values the creator asserted — these always win over defaults */
  supplied?: Record<string, unknown> | undefined
  /** door for the supplied values (defaults always log as `default`) */
  suppliedSource?: EventSource
  now?: Date
}

/**
 * Birth = supplied values, then defaults for whatever is still blank — one
 * transaction, one registry read, so a record never exists half-born and
 * an attribute archived mid-flight can't turn birth into an error. One
 * program for every creation path, so a record born from a sync and one
 * born from the dialog get the same treatment with different actors.
 */
/**
 * What birth reports back. `identity`/`identityValues` ride along unchanged
 * from the one write path (SPA-97): a record born holding a domain another
 * record already claims is the same collision an edit makes, and the create
 * dialog owes the operator the same sentence the rail does.
 */
export type BirthValuesResult = Pick<
  SetValuesResult,
  'defaulted' | 'identity' | 'identityValues'
>

export const birthValuesEffect = Effect.fn('birthValues')(function* (
  opts: BirthValuesInput,
): Effect.fn.Return<
  BirthValuesResult,
  AttributeValidationError | EntityNotFound | ValuesWriteFailed
> {
  const supplied = Object.fromEntries(
    Object.entries(opts.supplied ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== '',
    ),
  )
  const { defaulted, identity, identityValues } = yield* setValuesEffect({
    entityId: opts.entityId,
    patch: supplied,
    actor: opts.actor,
    ...(opts.suppliedSource ? { source: opts.suppliedSource } : {}),
    fillDefaults: { now: opts.now ?? new Date() },
  })
  return { defaulted, identity, identityValues }
})

/** Promise seam for creation paths the ratchet hasn't converted yet. */
export const birthValues = (
  opts: BirthValuesInput,
): Promise<BirthValuesResult> => Effect.runPromise(birthValuesEffect(opts))
