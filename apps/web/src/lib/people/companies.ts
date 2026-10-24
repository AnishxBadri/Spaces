import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, link, person } from '@spaces/db/schema'
import type { EntityValues } from '@spaces/db/schema/entities'
import { jsonString } from '@spaces/core/json'
import {
  AttributeValidationError,
  EntityNotFound,
  ValuesWriteFailed,
  setValuesInTx,
} from '@spaces/core/writes/attributes/values'
import type {
  Actor,
  EventSource,
  SetValuesResult,
  Tx,
} from '@spaces/core/writes/attributes/values'

/**
 * A person's companies: the `companies` record-reference attribute on people.
 * The value is authoritative; the write path materializes it as
 * `link(references, attr_slug: 'companies')`, which every reader joins.
 * Never write `contact_at`. Outside the server-fn barrel so tests call it.
 */
export const PERSON_COMPANIES = 'companies'

/** The edge a person's `companies` value materializes, for joins on `link`. */
export const personCompanyEdge = and(
  eq(link.relation, 'references'),
  eq(link.attrSlug, PERSON_COMPANIES),
)

/** A person's `companies` value as ids; anything else reads as none. */
export function companyIdsOf(values: EntityValues): Array<string> {
  const held = values[PERSON_COMPANIES]
  return Array.isArray(held)
    ? held.filter((id): id is string => typeof id === 'string')
    : []
}

export type PersonCompanyChange = {
  personId: string
  companyId: string
  action: 'link' | 'unlink'
  actor: Actor
  source?: EventSource
  suggestionId?: string
  refs?: Array<string>
}

/**
 * Add one company to a person's `companies`, or take one off, through
 * `setValuesInTx` — validated, logged as an `attribute_event`, linked.
 * Null when the value already said so and nothing was written.
 *
 * - The person's row is locked before the value is read: two adds racing on
 *   one person append in turn rather than each writing its own list.
 * - Taking off the last company clears the value.
 */
export async function setPersonCompanyInTx(
  tx: Tx,
  change: PersonCompanyChange,
): Promise<SetValuesResult | null> {
  const row = (
    await tx
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, change.personId))
      .for('update')
  ).at(0)
  if (!row)
    throw new EntityNotFound({
      entityId: change.personId,
      message: 'Person not found',
    })
  const held = companyIdsOf(row.values)
  const has = held.includes(change.companyId)
  if (change.action === 'link' ? has : !has) return null
  const next =
    change.action === 'link'
      ? [...held, change.companyId]
      : held.filter((id) => id !== change.companyId)
  return setValuesInTx(tx, {
    entityId: change.personId,
    patch: { [PERSON_COMPANIES]: next.length > 0 ? next : null },
    actor: change.actor,
    ...(change.source === undefined ? {} : { source: change.source }),
    ...(change.suggestionId === undefined
      ? {}
      : { suggestionId: change.suggestionId }),
    ...(change.refs === undefined ? {} : { refs: change.refs }),
  })
}

/** `setPersonCompanyInTx` in a transaction of its own. */
export const setPersonCompanyProgram = Effect.fn('setPersonCompanyProgram')(
  function* (
    change: PersonCompanyChange,
  ): Effect.fn.Return<
    SetValuesResult | null,
    AttributeValidationError | EntityNotFound | ValuesWriteFailed
  > {
    return yield* Effect.tryPromise({
      try: () => db.transaction((tx) => setPersonCompanyInTx(tx, change)),
      catch: (cause) =>
        cause instanceof AttributeValidationError ||
        cause instanceof EntityNotFound
          ? cause
          : new ValuesWriteFailed({ cause }),
    })
  },
)

export class CompanyPeopleFailed extends Schema.TaggedError<CompanyPeopleFailed>()(
  'CompanyPeopleFailed',
  { cause: Schema.Defect() },
) {}

/**
 * The company page's People rail: live people whose `companies` names this
 * company, by name.
 */
export const companyPeopleProgram = Effect.fn('companyPeopleProgram')(
  function* (companyId: string) {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: entity.id,
            name: entity.canonicalName,
            values: entity.values,
          })
          .from(link)
          .innerJoin(entity, eq(entity.id, link.fromEntityId))
          .innerJoin(person, eq(person.entityId, entity.id))
          .where(
            and(
              eq(link.toEntityId, companyId),
              personCompanyEdge,
              isNull(entity.mergedIntoId),
            ),
          )
          .orderBy(asc(entity.canonicalName), asc(entity.id)),
      catch: (cause) => new CompanyPeopleFailed({ cause }),
    })
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      headline: jsonString(p.values.job_title),
    }))
  },
)
