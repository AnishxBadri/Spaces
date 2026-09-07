import { valueValidator } from './registry'
import type { AttributeDef } from './registry'

/**
 * Pure half of defaults (spec §4): parsing a duration, resolving what a
 * default means at birth, validating one at attribute save. No db here —
 * the write path imports this, so it cannot import the write path.
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
