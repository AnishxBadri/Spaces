import { Effect } from 'effect'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { jsonStrings } from '@spaces/core/json'
import {
  UnknownVariable,
  checkVariables,
  parseVariables,
  resolveVariables,
} from '@spaces/core/templates/variables'
import type {
  VariablePath,
  VariableRecord,
  VariableStats,
} from '@spaces/core/templates/variables'
import { getRegistry } from '@spaces/core/writes/attributes/values'
import { db } from '@spaces/db'
import { entity, interactionStat } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type { DraftRecipient } from '@spaces/db/schema/drafts'
import { DraftFailed } from './email-drafts'

/**
 * The composer's Review (D67): every variable resolved per recipient, the
 * blanks named per row. The resolver is `resolveVariables`; this reads the
 * records it resolves against — the person's values, their current company
 * and their interaction stats.
 * - A path no attribute matches refuses the whole review, naming it.
 * - An address no record holds resolves every known path to a blank.
 */

/** One recipient's row of the review table. */
type ReviewRow = {
  email: string
  name: string | null
  values: { [path: VariablePath]: string | null }
  blanks: Array<VariablePath>
}

export type VariableReview = {
  /** The variables the draft uses, in the order first written. */
  paths: Array<VariablePath>
  rows: Array<ReviewRow>
}

type ReviewInput = {
  to: Array<DraftRecipient>
  cc: Array<DraftRecipient>
  bcc: Array<DraftRecipient>
  subject: string
  bodyMd: string
}

/** The sentence a client is shown. */
export function variableMessage(failure: unknown): string {
  if (failure instanceof UnknownVariable) return failure.message
  return 'Could not resolve the variables'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DraftFailed({ cause }) })

export const reviewVariablesProgram = Effect.fn('reviewVariablesProgram')(
  function* (
    input: ReviewInput,
  ): Effect.fn.Return<VariableReview, DraftFailed | UnknownVariable> {
    const text = `${input.subject}\n${input.bodyMd}`
    const paths = parseVariables(text)
    const attributes = yield* query(() => getRegistry('person'))
    const unknown = checkVariables(paths, attributes)
    if (unknown !== null) return yield* Effect.fail(unknown)

    const seen = new Set<string>()
    const recipients = [...input.to, ...input.cc, ...input.bcc].filter((r) => {
      const key = r.email.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const ids = [...new Set(recipients.flatMap((r) => r.entityId ?? []))]
    const people =
      ids.length === 0
        ? []
        : yield* query(() =>
            db
              .select({
                id: entity.id,
                canonicalName: entity.canonicalName,
                values: entity.values,
              })
              .from(entity)
              .where(
                and(
                  inArray(entity.id, ids),
                  eq(entity.kind, 'person'),
                  isNull(entity.mergedIntoId),
                ),
              ),
          )

    // The names a value or a company path shows: record and actor references.
    const recordRefs = attributes
      .filter((d) => d.type === 'record_reference')
      .map((d) => d.slug)
    const actorRefs = attributes
      .filter((d) => d.type === 'actor_reference')
      .map((d) => d.slug)
    const refIds = (slugs: ReadonlyArray<string>) => [
      ...new Set(
        people.flatMap((p) => slugs.flatMap((s) => jsonStrings(p.values[s]))),
      ),
    ]
    const entityRefs = [
      ...new Set([...refIds(recordRefs), ...refIds(['companies'])]),
    ]
    const userRefs = refIds(actorRefs)
    const entityNames =
      entityRefs.length === 0
        ? []
        : yield* query(() =>
            db
              .select({ id: entity.id, name: entity.canonicalName })
              .from(entity)
              .where(
                and(
                  inArray(entity.id, entityRefs),
                  isNull(entity.mergedIntoId),
                ),
              ),
          )
    const userNames =
      userRefs.length === 0
        ? []
        : yield* query(() =>
            db
              .select({ id: user.id, name: user.name })
              .from(user)
              .where(inArray(user.id, userRefs)),
          )
    const names = new Map(
      [...entityNames, ...userNames].map((n) => [n.id, n.name]),
    )

    const stats =
      ids.length === 0
        ? []
        : yield* query(() =>
            db
              .select({
                entityId: interactionStat.entityId,
                kind: interactionStat.kind,
                lastAt: interactionStat.lastAt,
                nextAt: interactionStat.nextAt,
              })
              .from(interactionStat)
              .where(
                and(
                  inArray(interactionStat.entityId, ids),
                  inArray(interactionStat.kind, ['any', 'email']),
                ),
              ),
          )
    const iso = (d: Date | null) => (d === null ? null : d.toISOString())
    const statsOf = (id: string): VariableStats => {
      const any = stats.find((s) => s.entityId === id && s.kind === 'any')
      const email = stats.find((s) => s.entityId === id && s.kind === 'email')
      return {
        last_interaction: iso(any?.lastAt ?? null),
        last_email: iso(email?.lastAt ?? null),
        next_meeting: iso(any?.nextAt ?? null),
      }
    }

    const records = new Map(
      people.map((p): [string, VariableRecord] => {
        // The current company is the first of the person's `companies`. (D60)
        const companyId = jsonStrings(p.values.companies).at(0)
        return [
          p.id,
          {
            canonicalName: p.canonicalName,
            values: p.values,
            company:
              companyId === undefined ? null : (names.get(companyId) ?? null),
            stats: statsOf(p.id),
          },
        ]
      }),
    )

    const rows: Array<ReviewRow> = []
    for (const r of recipients) {
      const record =
        r.entityId === undefined ? null : (records.get(r.entityId) ?? null)
      const resolved = resolveVariables(text, {
        attributes,
        record,
        names: (id) => names.get(id),
      })
      if (resolved instanceof UnknownVariable)
        return yield* Effect.fail(resolved)
      rows.push({
        email: r.email,
        name: record?.canonicalName ?? r.name ?? null,
        values: resolved.values,
        blanks: resolved.blanks,
      })
    }
    return { paths, rows }
  },
)
