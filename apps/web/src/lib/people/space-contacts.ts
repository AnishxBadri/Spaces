import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import { entity, entitySpace, link, person } from '@spaces/db/schema'
import { jsonString } from '#/lib/json'

/**
 * Contacts — the people of one space (SPA-99), the second half of CONTEXT's
 * "sources and contacts sections" open question and the same two-lane shape
 * SPA-44/SPA-67 settled for Sources:
 *
 * - **direct** — people with an `entity_space` row for this space, tagged in
 *   deliberately. These are the section, and the only thing the headline and
 *   the header readout count.
 * - **inherited** — people `contact_at` a company that is itself tagged into
 *   this space. A closed disclosure under the direct rows; never counted.
 *
 * Two programs rather than one union, for the reason `space-sources.ts`
 * gives: they answer different questions and the page renders them
 * differently.
 *
 * It lives outside `lib/server/` on purpose. `lib/server/spaces.ts` is
 * reachable from the client barrel and a plain export there ships to the
 * browser (CLAUDE.md → Traps, SPA-155); a test can call these without a
 * request, which `getSpace` would never allow.
 *
 * `entity.merged_into_id` is filtered in SQL on **both** ends of the
 * inherited join — a person merged away stops being a contact, and a company
 * merged away stops lending its contacts.
 */

export class SpaceContactsFailed extends Schema.TaggedError<SpaceContactsFailed>()(
  'SpaceContactsFailed',
  { cause: Schema.Defect() },
) {}

export type SpaceContact = {
  id: string
  name: string
  /** `job_title`, the same secondary fact the company page's People rail reads. */
  headline: string | null
  /**
   * The companies this person is `contact_at`, comma-joined and already
   * ordered — aggregated in SQL so the lane stays one statement and a
   * person at two companies is still one row.
   */
  companies: string | null
}

/**
 * A person reached through a company tagged into this space. The company is
 * part of the row because a person nobody tagged here has to say why they
 * are on the page at all — and one person contact at two companies here is
 * **two rows**, one under each, which is SPA-67's decision for documents
 * applied to the same question.
 */
export type InheritedContact = SpaceContact & {
  companyId: string
  companyName: string
}

/**
 * The `contact_at` companies of the person in the row being selected,
 * comma-joined. Correlated on `entity.id` — the person's `entity` row is
 * the only one under that name in either outer query, and the subquery
 * aliases its own copy to `contact_company`, so the reference cannot bind
 * to the wrong one.
 *
 * Merged-away companies are dropped here too: a name that redirects is not
 * a useful thing to print on a row.
 */
const contactCompanies = sql<string | null>`(
  select string_agg(contact_company.canonical_name, ', '
                    order by contact_company.canonical_name)
  from ${link} contact_link
  join ${entity} contact_company
    on contact_company.id = contact_link.to_entity_id
  where contact_link.from_entity_id = ${entity.id}
    and contact_link.relation = 'contact_at'
    and contact_company.merged_into_id is null
)`

/**
 * The columns both lanes read. One object, so the two queries cannot drift
 * into answering with different row shapes — the section renders them with
 * the same component.
 */
const contactColumns = {
  id: entity.id,
  name: entity.canonicalName,
  values: entity.values,
  companies: contactCompanies,
}

type ContactRow = {
  id: string
  name: string
  values: (typeof entity.$inferSelect)['values']
  companies: string | null
}

function toContact(r: ContactRow): SpaceContact {
  return {
    id: r.id,
    name: r.name,
    headline: jsonString(r.values.job_title),
    companies: r.companies,
  }
}

/**
 * The direct lane: people tagged into this space.
 *
 * `entity_space` accepts any kind, so the `person` join is what makes this
 * the Contacts lane and not the Companies one — and it is an inner join to
 * the `person` table rather than a `kind = 'person'` filter so the lane
 * agrees with the table that decides what a person is.
 *
 * Alphabetical, not newest-first: a contact list is read by name.
 */
export const spaceContactsProgram = Effect.fn('spaceContactsProgram')(
  function* (
    spaceId: string,
  ): Effect.fn.Return<Array<SpaceContact>, SpaceContactsFailed> {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select(contactColumns)
          .from(entitySpace)
          .innerJoin(entity, eq(entity.id, entitySpace.entityId))
          .innerJoin(person, eq(person.entityId, entity.id))
          .where(
            and(eq(entitySpace.spaceId, spaceId), isNull(entity.mergedIntoId)),
          )
          .orderBy(asc(entity.canonicalName)),
      catch: (cause) => new SpaceContactsFailed({ cause }),
    })

    return rows.map(toContact)
  },
)

/**
 * The inherited lane: people `contact_at` a company tagged into this space —
 * the same edge `lib/server/companies.ts` reads for the company page's
 * Contacts rail, walked from the space end instead of the company end. One
 * statement, not a query per company: a space with forty companies is
 * ordinary and forty round trips is not.
 *
 * Three things the joins have to get right:
 *
 * - **Two `entity` rows are in play**, the company's and the person's, so
 *   the company's is aliased and `merged_into_id` is checked on each.
 * - **A person also tagged here appears once, in the direct lane.** The
 *   `not exists` below drops them from this one — tagged in deliberately is
 *   the stronger claim, and the page must not tell two stories about one
 *   person.
 * - **The row is per edge, not per person.** A founder who is contact at two
 *   companies both tagged here is two rows, one under each company, which is
 *   what the company column is for; `link_edge_unique` stops a third.
 *
 * Inheritance never reaches the section's headline count or the header
 * readout. The headline says who was tagged here; this is a convenience lane.
 */
export const spaceInheritedContactsProgram = Effect.fn(
  'spaceInheritedContactsProgram',
)(function* (
  spaceId: string,
): Effect.fn.Return<Array<InheritedContact>, SpaceContactsFailed> {
  const companyEntity = alias(entity, 'company_entity')
  const taggedHere = alias(entitySpace, 'tagged_here')

  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          ...contactColumns,
          companyId: companyEntity.id,
          companyName: companyEntity.canonicalName,
        })
        .from(entitySpace)
        .innerJoin(companyEntity, eq(companyEntity.id, entitySpace.entityId))
        .innerJoin(
          link,
          and(
            eq(link.toEntityId, companyEntity.id),
            eq(link.relation, 'contact_at'),
          ),
        )
        .innerJoin(entity, eq(entity.id, link.fromEntityId))
        .innerJoin(person, eq(person.entityId, entity.id))
        .where(
          and(
            eq(entitySpace.spaceId, spaceId),
            eq(companyEntity.kind, 'company'),
            isNull(companyEntity.mergedIntoId),
            isNull(entity.mergedIntoId),
            notExists(
              db
                .select({ tagged: sql`1` })
                .from(taggedHere)
                .where(
                  and(
                    eq(taggedHere.entityId, entity.id),
                    eq(taggedHere.spaceId, spaceId),
                  ),
                ),
            ),
          ),
        )
        // Grouped by the company that lent them, then alphabetical inside it
        // — the disclosure reads as a list of companies, not a shuffle.
        .orderBy(asc(companyEntity.canonicalName), asc(entity.canonicalName)),
    catch: (cause) => new SpaceContactsFailed({ cause }),
  })

  return rows.map((r) => ({
    ...toContact(r),
    companyId: r.companyId,
    companyName: r.companyName,
  }))
})
