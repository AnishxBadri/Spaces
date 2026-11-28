import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { interaction } from '@spaces/db/schema'
import { canReadNoteSql } from '@spaces/core/writes/read/search'
import type { MeetingsFilters, WriteUpFilter } from '#/lib/meetings/filter'
import type { MeetingsTab } from '#/lib/meetings/list'

/**
 * The Meetings page's search and filters as SQL over `interaction`, so the
 * list read and the panel's counts narrow by one copy. User text reaches
 * the statement only as a bound parameter.
 */

/** The facets, by the keys the panel's counts name them. */
export type MeetingsFacet = 'with' | 'member' | 'kind' | 'writeUp' | 'cancelled'

export const cancelledSql = sql`(coalesce(${interaction.meta} ->> 'status', '') = 'cancelled')`

/** `text` as a case-blind `ilike` pattern that matches it anywhere, wildcards escaped. */
const containing = (text: string) =>
  `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/**
 * The search over titles and people: the subject, a person record edged to
 * the meeting, or an organiser's or invitee's address. Never the write-up,
 * which the reader may not be allowed to read.
 */
export function meetingSearchSql(q: string): SQL {
  const p = containing(q)
  return sql`(coalesce(${interaction.subject}, '') ilike ${p}
    or exists (
      select 1 from interaction_entity qie
      join entity qe on qe.id = qie.entity_id
      where qie.interaction_id = ${interaction.id}
        and qe.kind = 'person'
        and qe.merged_into_id is null
        and qe.canonical_name ilike ${p}
    )
    or coalesce(${interaction.meta} ->> 'organizer', '') ilike ${p}
    or exists (
      select 1 from jsonb_object_keys(case when jsonb_typeof(${interaction.meta} -> 'rsvp') = 'object' then ${interaction.meta} -> 'rsvp' else '{}'::jsonb end) qk
      where qk ilike ${p}
    ))`
}

/**
 * One `Write-up` value. `By a recorder` holds only a write-up the reader may
 * read, so the filter tells nothing the row would not.
 */
export function writeUpSql(value: WriteUpFilter, readerId: string): SQL {
  switch (value) {
    case 'written':
      return sql`(${interaction.noteId} is not null)`
    case 'none':
      return sql`(${interaction.noteId} is null)`
    case 'recorder':
      // `e` is the alias canReadNoteSql reads; it shadows any outer `e`.
      return sql`exists (
        select 1 from entity e
        where e.id = ${interaction.noteId}
          and e.source_ref is not null
          and ${canReadNoteSql(readerId)}
      )`
  }
}

const anyOf = (parts: ReadonlyArray<SQL>): SQL =>
  sql`(${sql.join([...parts], sql` or `)})`

/**
 * The conditions the search and the filters add to a tab's read, `except`
 * one facet left off, as a panel count reads its own facet.
 * - `memberSql` is the chosen member's meetings, built by the read, which
 *   knows the team.
 * - Past leaves cancelled meetings out until `Show`; Upcoming keeps them,
 *   struck, until `Hide`.
 */
export function meetingFilterConditions(
  params: {
    readonly tab: MeetingsTab
    readonly filters: MeetingsFilters
    readonly q: string
    readonly readerId: string
    readonly memberSql: SQL | null
  },
  except: MeetingsFacet | null,
): Array<SQL> {
  const { tab, filters: f, q } = params
  const out: Array<SQL> = []
  if (q !== '') out.push(meetingSearchSql(q))
  if (except !== 'with' && f.with !== null)
    out.push(sql`exists (
      select 1 from interaction_entity wie
      where wie.interaction_id = ${interaction.id}
        and wie.entity_id = ${f.with}::uuid
    )`)
  if (except !== 'member' && params.memberSql !== null)
    out.push(params.memberSql)
  if (tab === 'past' && except !== 'kind' && f.kind.length > 0)
    out.push(anyOf(f.kind.map((k) => sql`${interaction.kind} = ${k}`)))
  if (tab === 'past' && except !== 'writeUp' && f.writeUp.length > 0)
    out.push(anyOf(f.writeUp.map((w) => writeUpSql(w, params.readerId))))
  if (except !== 'cancelled') {
    const leaveOut = tab === 'past' ? !f.cancelled : f.cancelled
    if (leaveOut) out.push(sql`not ${cancelledSql}`)
  }
  return out
}

/**
 * Past's band a row falls in, as `pastBands` keys it: `unwritten` (while
 * the owing lead), `This week`, `Last week` from the reader's Monday, else
 * the month, all in the reader's time zone.
 */
export function pastBandKeySql(params: {
  readonly now: Date
  readonly tz: string
  readonly unwrittenSql: SQL | null
}): SQL {
  const local = sql`(${interaction.occurredAt} at time zone ${params.tz}::text)`
  const week = sql`date_trunc('week', (${params.now}::timestamptz at time zone ${params.tz}::text))`
  const owes =
    params.unwrittenSql === null
      ? sql``
      : sql`when ${params.unwrittenSql} then 'unwritten' `
  return sql`(case ${owes}when ${local} >= ${week} then 'This week' when ${local} >= ${week} - interval '7 days' then 'Last week' else to_char(${local}, 'YYYY-MM') end)`
}

/** A row's local month, `2026-09`, in the reader's time zone. */
export const monthKeySql = (tz: string): SQL =>
  sql`to_char((${interaction.occurredAt} at time zone ${tz}::text), 'YYYY-MM')`

/** Rows that start before the end of `month` (`YYYY-MM`) in the reader's time zone. */
export const beforeMonthEndSql = (month: string, tz: string): SQL =>
  sql`${interaction.occurredAt} < (((${month}::text || '-01')::date + interval '1 month')::timestamp at time zone ${tz}::text)`
