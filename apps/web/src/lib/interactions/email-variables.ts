import { Effect } from 'effect'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { jsonStrings } from '@spaces/core/json'
import {
  UnknownVariable,
  checkVariables,
  parseVariables,
  resolveVariables,
  variablePaths,
} from '@spaces/core/templates/variables'
import type {
  VariableContext,
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
 * The composer's Review: every variable resolved per recipient, the
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

/** What each recipient's variables resolve against, the paths checked first. */
export type RecipientContexts = {
  /** The record a recipient is, or null for an address no record holds. */
  recordOf: (r: DraftRecipient) => VariableRecord | null
  contextOf: (r: DraftRecipient) => VariableContext
}

/**
 * The records `recipients` resolve against: each person's values, their
 * current company and their interaction stats. A path in `text` no
 * attribute matches refuses, naming it.
 */
export const recipientContextsProgram = Effect.fn('recipientContexts')(
  function* (
    text: string,
    recipients: ReadonlyArray<DraftRecipient>,
  ): Effect.fn.Return<RecipientContexts, DraftFailed | UnknownVariable> {
    const attributes = yield* query(() => getRegistry('person'))
    const unknown = checkVariables(parseVariables(text), attributes)
    if (unknown !== null) return yield* Effect.fail(unknown)
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
        // The current company is the first of the person's `companies`.
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

    const recordOf = (r: DraftRecipient) =>
      r.entityId === undefined ? null : (records.get(r.entityId) ?? null)
    return {
      recordOf,
      contextOf: (r) => ({
        attributes,
        record: recordOf(r),
        names: (id) => names.get(id),
      }),
    }
  },
)

/** Each address once, the first spelling kept: To, then Cc, then Bcc. */
export function distinctRecipients(
  lines: ReadonlyArray<ReadonlyArray<DraftRecipient>>,
): Array<DraftRecipient> {
  const seen = new Set<string>()
  return lines.flat().filter((r) => {
    const key = r.email.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A path the composer's Variable picker offers: what it writes and its name. */
export type VariableOption = { path: VariablePath; label: string }

/** The picker's list: the families, then the person's live attributes. */
export const variableOptionsProgram = Effect.fn('variableOptionsProgram')(
  function* (): Effect.fn.Return<Array<VariableOption>, DraftFailed> {
    const attributes = yield* query(() => getRegistry('person'))
    return variablePaths(attributes)
  },
)

export const reviewVariablesProgram = Effect.fn('reviewVariablesProgram')(
  function* (
    input: ReviewInput,
  ): Effect.fn.Return<VariableReview, DraftFailed | UnknownVariable> {
    const text = `${input.subject}\n${input.bodyMd}`
    const paths = parseVariables(text)
    const recipients = distinctRecipients([input.to, input.cc, input.bcc])
    const contexts = yield* recipientContextsProgram(text, recipients)
    const rows: Array<ReviewRow> = []
    for (const r of recipients) {
      const resolved = resolveVariables(text, contexts.contextOf(r))
      if (resolved instanceof UnknownVariable)
        return yield* Effect.fail(resolved)
      rows.push({
        email: r.email,
        name: contexts.recordOf(r)?.canonicalName ?? r.name ?? null,
        values: resolved.values,
        blanks: resolved.blanks,
      })
    }
    return { paths, rows }
  },
)
