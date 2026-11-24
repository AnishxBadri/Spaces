import { Effect } from 'effect'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entityAlias, interactionStat } from '@spaces/db/schema'
import type { DraftRecipient } from '@spaces/db/schema/drafts'
import type { EntityValues } from '@spaces/db/schema/entities'
import { jsonString } from '@spaces/core/json'
import { companyPeopleProgram } from '#/lib/people/companies'
import { DraftFailed, getDraftProgram } from './email-drafts'
import type { EmailDraft } from './email-drafts'
import { prefillTo } from './email-compose-prefill'
import { signatureProgram } from './email-signature'
import type { PrefillPerson, PrefillRecord } from './email-compose-prefill'

/**
 * What the composer window opens on: the viewer's draft under that id when
 * one is held, else what a new email starts with — To from the record it
 * was started on (`prefillTo`). The record is named for Attach's files.
 * A new email stores nothing about the record: it lives only under Drafts.
 */
export type ComposeOpening = {
  draft: EmailDraft | null
  to: Array<DraftRecipient>
  record: { id: string; name: string } | null
  /**
   * The viewer's signature: a new email's foot, and what a template applied
   * later keeps there. A held draft's body is never signed again.
   */
  signature: string
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DraftFailed({ cause }) })

/** People by id with their first email alias and their last email. */
const prefillPeople = Effect.fn('prefillPeople')(function* (
  people: ReadonlyArray<{ id: string; name: string }>,
) {
  if (people.length === 0) return []
  const ids = people.map((p) => p.id)
  const aliases = yield* query(() =>
    db
      .select({ entityId: entityAlias.entityId, email: entityAlias.value })
      .from(entityAlias)
      .where(
        and(inArray(entityAlias.entityId, ids), eq(entityAlias.kind, 'email')),
      )
      .orderBy(desc(entityAlias.isIdentity), asc(entityAlias.createdAt)),
  )
  const stats = yield* query(() =>
    db
      .select({
        entityId: interactionStat.entityId,
        lastAt: interactionStat.lastAt,
      })
      .from(interactionStat)
      .where(
        and(
          inArray(interactionStat.entityId, ids),
          eq(interactionStat.kind, 'email'),
        ),
      ),
  )
  return people.map((p): PrefillPerson => ({
    entityId: p.id,
    name: p.name,
    email: aliases.find((a) => a.entityId === p.id)?.email ?? null,
    lastEmailAt:
      stats.find((s) => s.entityId === p.id)?.lastAt?.toISOString() ?? null,
  }))
})

/** A company's people, as the prefill reads them. */
const teamOf = Effect.fn('composeTeamOf')(function* (companyId: string) {
  const team = yield* companyPeopleProgram(companyId).pipe(
    Effect.mapError((e) => new DraftFailed({ cause: e.cause })),
  )
  return yield* prefillPeople(team)
})

/** The record's kind and the people the prefill chooses among. */
const prefillRecordOf = Effect.fn('prefillRecordOf')(function* (row: {
  id: string
  kind: string
  name: string
  values: EntityValues
}) {
  if (row.kind === 'person') {
    const person = (yield* prefillPeople([{ id: row.id, name: row.name }])).at(
      0,
    )
    return person === undefined
      ? ({ kind: 'other' } satisfies PrefillRecord)
      : ({ kind: 'person', person } satisfies PrefillRecord)
  }
  if (row.kind === 'company')
    return {
      kind: 'company',
      team: yield* teamOf(row.id),
    } satisfies PrefillRecord
  if (row.kind === 'deal') {
    const companyId = jsonString(row.values.company)
    return {
      kind: 'deal',
      team: companyId === null ? [] : yield* teamOf(companyId),
    } satisfies PrefillRecord
  }
  return { kind: 'other' } satisfies PrefillRecord
})

export const openComposeProgram = Effect.fn('openComposeProgram')(function* (
  viewer: { id: string },
  input: { draftId: string | null; recordId: string | null },
): Effect.fn.Return<ComposeOpening, DraftFailed> {
  const draft =
    input.draftId === null
      ? null
      : yield* getDraftProgram(viewer, input.draftId).pipe(
          Effect.catchTag('DraftNotFound', () => Effect.succeed(null)),
        )
  const { recordId } = input
  const row =
    recordId === null
      ? undefined
      : (yield* query(() =>
          db
            .select({
              id: entity.id,
              kind: entity.kind,
              name: entity.canonicalName,
              values: entity.values,
            })
            .from(entity)
            .where(eq(entity.id, recordId)),
        )).at(0)
  const record = row === undefined ? null : { id: row.id, name: row.name }
  const signature = yield* signatureProgram(viewer).pipe(
    Effect.mapError((e) => new DraftFailed({ cause: e.cause })),
  )
  if (draft !== null || row === undefined)
    return { draft, to: [], record, signature }
  return {
    draft,
    to: prefillTo(yield* prefillRecordOf(row)),
    record,
    signature,
  }
})
