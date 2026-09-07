import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '#/db'
import { entity } from '#/db/schema'
import { objectIdForKindAsync } from './objects'
import { valueValidator } from './registry'
import {
  EntityNotFound,
  ValuesWriteFailed,
  getRegistryByObjectId,
  setValuesEffect,
} from './values'
import type { AttributeDef, ObjectKind } from './registry'
import type {
  Actor,
  AttributeValidationError,
  EventSource,
  SetValuesInput,
} from './values'

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

const DURATION =
  /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

export const isIsoDuration = (v: unknown): v is string =>
  typeof v === 'string' && DURATION.test(v)

/** `now` plus an ISO-8601 duration, in UTC calendar arithmetic. */
export function addIsoDuration(now: Date, duration: string): Date {
  const m = DURATION.exec(duration)
  if (!m) throw new Error(`Not an ISO-8601 duration: ${duration}`)
  const [, y, mo, w, d, h, mi, s] = m.map((x) => (x ? Number(x) : 0))
  const out = new Date(now.getTime())
  out.setUTCFullYear(out.getUTCFullYear() + y, out.getUTCMonth() + mo)
  out.setUTCDate(out.getUTCDate() + w * 7 + d)
  out.setUTCHours(out.getUTCHours() + h, out.getUTCMinutes() + mi)
  out.setUTCSeconds(out.getUTCSeconds() + s)
  return out
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/**
 * What a default means at birth. `undefined` = nothing to write (no default,
 * or `current-user` with no human present).
 */
export function resolveDefault(
  def: Pick<AttributeDef, 'type' | 'options'>,
  ctx: { now: Date; userId: string | null },
): unknown {
  const d = def.options.default
  if (d === undefined || d === null) return undefined
  if (def.type === 'actor_reference' && d === 'current-user')
    return ctx.userId ?? undefined
  if (def.type === 'date' && isIsoDuration(d))
    return isoDate(addIsoDuration(ctx.now, d))
  return d
}

/**
 * Config-time check (attribute save): a bad default is rejected when it's
 * set, never at record creation. Returns the problem, or null when fine.
 */
export function validateDefault(
  def: Pick<AttributeDef, 'type' | 'options'>,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null
  if (def.type === 'actor_reference') {
    return typeof value === 'string' && value.length > 0 && value.length <= 64
      ? null
      : "Expected 'current-user' or a user id"
  }
  if (def.type === 'date' && isIsoDuration(value)) return null
  const parsed = valueValidator(def).safeParse(value)
  if (parsed.success) return null
  const detail = parsed.error.issues[0]?.message ?? 'Invalid value'
  return def.type === 'date'
    ? `${detail}, or an ISO-8601 duration such as P7D`
    : detail
}

export type BirthValuesInput = {
  entityId: string
  actor: Actor
  /** values the creator asserted — these always win over defaults */
  supplied?: Record<string, unknown>
  /** door for the supplied values (defaults always log as `default`) */
  suppliedSource?: EventSource
  now?: Date
}

/**
 * Birth = supplied values, then defaults for whatever is still blank. One
 * program for every creation path, so a record born from a sync and one
 * born from the dialog get the same treatment with different actors.
 */
export const birthValuesEffect = Effect.fn('birthValues')(function* (
  opts: BirthValuesInput,
): Effect.fn.Return<
  { defaulted: Array<string> },
  AttributeValidationError | EntityNotFound | ValuesWriteFailed
> {
  const { entityId, actor, now = new Date() } = opts
  const supplied = Object.fromEntries(
    Object.entries(opts.supplied ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== '',
    ),
  )
  if (Object.keys(supplied).length > 0) {
    const write: SetValuesInput = { entityId, patch: supplied, actor }
    if (opts.suppliedSource) write.source = opts.suppliedSource
    yield* setValuesEffect(write)
  }

  const ent = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          kind: entity.kind,
          objectId: entity.objectId,
          values: entity.values,
        })
        .from(entity)
        .where(eq(entity.id, entityId))
        .then((rows) => rows.at(0)),
    catch: (cause) => new ValuesWriteFailed({ cause }),
  })
  if (!ent)
    return yield* new EntityNotFound({ entityId, message: 'Entity not found' })
  // Research kinds (space/note/document/term, organization) carry no
  // registry and so no defaults.
  const objectId =
    ent.objectId ??
    (['company', 'person', 'deal'].includes(ent.kind)
      ? yield* Effect.tryPromise({
          try: () => objectIdForKindAsync(ent.kind as ObjectKind),
          catch: (cause) => new ValuesWriteFailed({ cause }),
        })
      : null)
  if (!objectId) return { defaulted: [] }

  const registry = yield* Effect.tryPromise({
    try: () => getRegistryByObjectId(objectId),
    catch: (cause) => new ValuesWriteFailed({ cause }),
  })
  const current = (ent.values ?? {}) as Record<string, unknown>
  const userId = actor.type === 'user' ? actor.id : null

  const patch: Record<string, unknown> = {}
  for (const def of registry) {
    if (def.slug in supplied) continue
    if (current[def.slug] !== undefined && current[def.slug] !== null) continue
    const value = resolveDefault(def, { now, userId })
    if (value !== undefined) patch[def.slug] = value
  }
  if (Object.keys(patch).length === 0) return { defaulted: [] }

  const { changed } = yield* setValuesEffect({
    entityId,
    patch,
    actor,
    source: 'default',
  })
  return { defaulted: changed }
})

/** Promise seam for creation paths the ratchet hasn't converted yet. */
export const birthValues = (
  opts: BirthValuesInput,
): Promise<{ defaulted: Array<string> }> =>
  Effect.runPromise(birthValuesEffect(opts))
