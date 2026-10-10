import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  apiToken,
  entity,
  entitySpace,
  integration,
  space,
  suggestion,
} from '@spaces/db/schema'
import { discoverySpaceOf } from '@spaces/core/ai/discovery'
import { jsonRecord, jsonString } from '@spaces/core/json'
import { isDiscoveryKind } from '@spaces/core/writes/suggestions/propose'

/** Today's Review rows: the open queue counted by source and space. (D79) */

export class ReviewGroupsFailed extends Schema.TaggedError<ReviewGroupsFailed>()(
  'ReviewGroupsFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ReviewGroupsFailed({ cause }),
  })

/** A proposer id an `integration` or `api_token` row could carry. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The source a card's proposer reads as when no integration wrote it. */
export const JUDGMENT = 'Judgment'

/** Review's `source` filter for every card no integration or token proposed. */
export const JUDGMENT_REF = 'judgment'

/**
 * The `source` filter a card answers to: its integration's or API token's
 * id, or `judgment`. Null for an integration card with no proposer id,
 * which no filter can name.
 */
export const sourceRefOf = (s: {
  proposedByType: 'user' | 'integration' | 'system'
  proposedById: string | null
}): string | null =>
  s.proposedByType === 'integration' ? s.proposedById : JUDGMENT_REF

/** Open Review cards from one source about one space. */
export type ReviewGroup = {
  key: string
  /** The space the cards are about; null for records filed nowhere. */
  spaceId: string | null
  /** `Proptech / Property ops`. */
  spaceLabel: string | null
  /** An integration's name, an API token's name, or `Judgment`. */
  source: string
  /** Review's `source` filter for these cards; null when none can name them. */
  sourceRef: string | null
  /** Discovery cards: companies to add, records to file here. */
  toAdd: number
  toFile: number
  /** Every other card: a value, a note, a tag, a task to accept. */
  toReview: number
  total: number
  /** The oldest card's `created_at`, ISO. */
  oldestAt: string
}

/** Every live space labelled by its path of names, `Fintech / Payments`. */
const spaceLabels = Effect.fn('spaceLabels')(function* () {
  const rows = yield* query(() =>
    db
      .select({
        id: space.entityId,
        path: space.path,
        name: entity.canonicalName,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(and(isNull(entity.mergedIntoId), isNull(space.archivedAt))),
  )
  const names = new Map(rows.map((r) => [r.path, r.name]))
  return new Map(
    rows.map((r) => {
      const parts = r.path.split('.')
      const label = parts
        .map((_, i) => names.get(parts.slice(0, i + 1).join('.')) ?? parts[i])
        .join(' / ')
      return [r.id, label] as const
    }),
  )
})

/**
 * Open suggestions, one group per (source, space).
 * - A discovery card's space is its payload's; any other card's is the
 *   record's earliest live filing, or none.
 * - Discovery cards never share a group with other cards: a space's
 *   discovery row counts `add_record` and `file_record` only.
 * - Groups come back largest first.
 */
export const reviewGroupsProgram = Effect.fn('reviewGroupsProgram')(
  function* (): Effect.fn.Return<ReviewGroup[], ReviewGroupsFailed> {
    const open = yield* query(() =>
      db
        .select({
          kind: suggestion.kind,
          entityId: suggestion.entityId,
          payload: suggestion.payload,
          proposedByType: suggestion.proposedByType,
          proposedById: suggestion.proposedById,
          createdAt: suggestion.createdAt,
        })
        .from(suggestion)
        .where(eq(suggestion.status, 'open')),
    )
    if (open.length === 0) return []

    const labels = yield* spaceLabels()
    const recordIds = [
      ...new Set(
        open.flatMap((s) =>
          isDiscoveryKind(s.kind) || s.entityId === null ? [] : [s.entityId],
        ),
      ),
    ]
    const filings =
      recordIds.length === 0
        ? []
        : yield* query(() =>
            db
              .select({
                entityId: entitySpace.entityId,
                spaceId: entitySpace.spaceId,
              })
              .from(entitySpace)
              .where(inArray(entitySpace.entityId, recordIds))
              .orderBy(asc(entitySpace.createdAt), asc(entitySpace.spaceId)),
          )
    const filedIn = new Map<string, string>()
    for (const f of filings)
      if (!filedIn.has(f.entityId) && labels.has(f.spaceId))
        filedIn.set(f.entityId, f.spaceId)

    const proposerIds = [
      ...new Set(
        open.flatMap((s) =>
          s.proposedByType === 'integration' && s.proposedById !== null
            ? [s.proposedById]
            : [],
        ),
      ),
    ].filter((id) => UUID.test(id))
    const [integrations, tokens] =
      proposerIds.length === 0
        ? [[], []]
        : yield* query(() =>
            Promise.all([
              db
                .select({
                  id: integration.id,
                  capabilityId: integration.capabilityId,
                  manifest: integration.manifest,
                })
                .from(integration)
                .where(inArray(integration.id, proposerIds)),
              db
                .select({ id: apiToken.id, name: apiToken.name })
                .from(apiToken)
                .where(inArray(apiToken.id, proposerIds)),
            ]),
          )
    const sourceName = new Map<string, string>([
      ...integrations.map(
        (i) =>
          [
            i.id,
            jsonString(jsonRecord(i.manifest).name) ?? i.capabilityId,
          ] as const,
      ),
      ...tokens.map((t) => [t.id, t.name] as const),
    ])

    const groups = new Map<string, ReviewGroup>()
    for (const s of open) {
      const spaceId = isDiscoveryKind(s.kind)
        ? discoverySpaceOf(s.payload)
        : s.entityId === null
          ? null
          : (filedIn.get(s.entityId) ?? null)
      const source =
        s.proposedByType === 'integration' && s.proposedById !== null
          ? (sourceName.get(s.proposedById) ?? 'Integration')
          : JUDGMENT
      const sourceRef = sourceRefOf(s)
      // A space's discovery cards are their own row, so it counts only add
      // and file cards.
      const key = `${sourceRef ?? source}|${spaceId ?? ''}${isDiscoveryKind(s.kind) ? '|discovery' : ''}`
      const at = s.createdAt.toISOString()
      const g = groups.get(key) ?? {
        key,
        spaceId,
        spaceLabel: spaceId === null ? null : (labels.get(spaceId) ?? null),
        source,
        sourceRef,
        toAdd: 0,
        toFile: 0,
        toReview: 0,
        total: 0,
        oldestAt: at,
      }
      if (s.kind === 'add_record') g.toAdd += 1
      else if (s.kind === 'file_record') g.toFile += 1
      else g.toReview += 1
      g.total += 1
      if (at < g.oldestAt) g.oldestAt = at
      groups.set(key, g)
    }
    return [...groups.values()].sort(
      (a, b) => b.total - a.total || a.key.localeCompare(b.key),
    )
  },
)
