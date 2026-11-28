import { Schema } from 'effect'
import type { MeetingsTab } from './list'

/**
 * What the Meetings page can be narrowed by, as data: the facets' values
 * and labels, and the address's spelling of each. Client-safe, so the page,
 * the list read and its test share one copy; the SQL that applies them sits
 * beside the read.
 */

/** A row's kind, as the `Kind` facet names it. */
export const MEETING_KINDS = ['meeting', 'call'] as const
export type MeetingKind = (typeof MEETING_KINDS)[number]

/**
 * `Write-up`: one exists, none does, or a recorder wrote it. The values are
 * ORed, so `Written` already holds what `By a recorder` holds.
 */
export const WRITE_UP_FILTERS = ['written', 'none', 'recorder'] as const
export type WriteUpFilter = (typeof WRITE_UP_FILTERS)[number]

export const KIND_LABELS: Readonly<Record<MeetingKind, string>> = {
  meeting: 'Meetings',
  call: 'Calls',
}

export const WRITE_UP_LABELS: Readonly<Record<WriteUpFilter, string>> = {
  written: 'Written',
  none: 'None',
  recorder: 'By a recorder',
}

/**
 * The filters that are on. Facets are ANDed; the values inside one are ORed.
 * - `with` and `member` hold on both tabs; `kind` and `writeUp` on Past only.
 * - `cancelled` is the one chip whose sense is the tab's: on Past it shows
 *   the cancelled meetings Past leaves out, on Upcoming it hides the ones
 *   the agenda strikes.
 */
export type MeetingsFilters = {
  /** A company or person record the meeting is edged to. */
  readonly with: string | null
  /** One member's meetings, whatever `Mine · Everyone` says. */
  readonly member: string | null
  readonly kind: ReadonlyArray<MeetingKind>
  readonly writeUp: ReadonlyArray<WriteUpFilter>
  readonly cancelled: boolean
}

export const NO_MEETING_FILTERS: MeetingsFilters = {
  with: null,
  member: null,
  kind: [],
  writeUp: [],
  cancelled: false,
}

const uuid = Schema.String.check(Schema.isUUID())

/** The list read's filters at the server-fn boundary. */
export const MeetingsFiltersSchema = Schema.Struct({
  with: Schema.NullOr(uuid),
  member: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
  kind: Schema.Array(Schema.Literals(MEETING_KINDS)),
  writeUp: Schema.Array(Schema.Literals(WRITE_UP_FILTERS)),
  cancelled: Schema.Boolean,
})

/** A month as `Jump to` names it: `2026-09`. */
export const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/

/** The filters the open tab reads: `Kind` and `Write-up` are Past's alone. */
export function filtersFor(
  f: MeetingsFilters,
  tab: MeetingsTab,
): MeetingsFilters {
  return tab === 'past' ? f : { ...f, kind: [], writeUp: [] }
}

/** How many filters are on in the open tab: the `Filter 2` count. */
export function meetingFiltersOn(f: MeetingsFilters, tab: MeetingsTab): number {
  const on = filtersFor(f, tab)
  return (
    (on.with === null ? 0 : 1) +
    (on.member === null ? 0 : 1) +
    on.kind.length +
    on.writeUp.length +
    (on.cancelled ? 1 : 0)
  )
}

/**
 * The filters, the search and the month as the address spells them: each
 * absent at its default, so `/meetings` stays plain.
 */
export type MeetingsFiltersAddress = {
  readonly with?: string | undefined
  readonly member?: string | undefined
  readonly kind?: string | undefined
  readonly wu?: string | undefined
  readonly cancelled?: boolean | undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The tokens of a comma list that are one of `allowed`, in `allowed`'s order. */
function tokens<T extends string>(
  list: string | undefined,
  allowed: ReadonlyArray<T>,
): Array<T> {
  const have = new Set((list ?? '').split(','))
  return allowed.filter((t) => have.has(t))
}

/** The address read as filters; an unknown token is dropped, not an error. */
export function meetingFiltersOf(
  address: MeetingsFiltersAddress,
): MeetingsFilters {
  const member = address.member?.trim() ?? ''
  return {
    with:
      address.with !== undefined && UUID.test(address.with)
        ? address.with.toLowerCase()
        : null,
    member: member === '' ? null : member,
    kind: tokens(address.kind, MEETING_KINDS),
    writeUp: tokens(address.wu, WRITE_UP_FILTERS),
    cancelled: address.cancelled === true,
  }
}

const list = (values: ReadonlyArray<string>): string | undefined =>
  values.length === 0 ? undefined : values.join(',')

/** Filters as the address spells them; every empty facet is `undefined`. */
export function meetingAddressOf(f: MeetingsFilters): {
  with: string | undefined
  member: string | undefined
  kind: string | undefined
  wu: string | undefined
  cancelled: boolean | undefined
} {
  return {
    with: f.with ?? undefined,
    member: f.member ?? undefined,
    kind: list(f.kind),
    wu: list(f.writeUp),
    cancelled: f.cancelled ? true : undefined,
  }
}

/** `values` with `value` added, or taken out when it is there. */
export function toggledValue<T extends string>(
  values: ReadonlyArray<T>,
  value: T,
  order: ReadonlyArray<T>,
): Array<T> {
  const next = new Set(values)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return order.filter((v) => next.has(v))
}
