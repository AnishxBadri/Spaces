import { Effect } from 'effect'
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  attribute,
  attributeEvent,
  entity,
  entitySpace,
  objectDef,
  space,
} from '@spaces/db/schema'
import type { EntityValues } from '@spaces/db/schema'
import { CORE_OBJECTS } from '../../attributes/registry'
import type { AttributeDef } from '../../attributes/registry'
import { PEER_MAX } from '../../context/rank'
import type { Candidate } from '../../context/rank'
import { ref } from '../../context/ref'
import { renderAttribute } from '../../context/render'
import { BRIEF_KEY_SLUGS } from './space-brief'
import { query } from './spaces'

/**
 * Where a record sits in the market map, and what sits beside it. (D71)
 * - Position: one hop-0 item per filed space, naming its full path. A space
 *   archived on its path gives none.
 * - Peers: other companies filed in a leaf space — a filed space no other
 *   filing sits under — each with its key values, as `peer` candidates.
 *   The read ranks by stage and recency and keeps `PEER_MAX`, exactly as
 *   the ranker does, so a large leaf never cuts the nearest before ranking.
 */

const STAGE_SLUG = 'funding_stage'

export type FiledSpace = { spaceId: string; path: string }

/** The live attribute defs of some objects, in their order. */
export const defsOfObjects = (objectIds: ReadonlyArray<string>) =>
  query(async () =>
    objectIds.length === 0
      ? []
      : db
          .select()
          .from(attribute)
          .where(
            and(
              inArray(attribute.objectId, [...objectIds]),
              eq(attribute.archived, false),
            ),
          )
          .orderBy(asc(attribute.sortOrder), asc(attribute.slug)),
  ).pipe(
    Effect.map((rows) => {
      const byObject = new Map<string, Array<AttributeDef>>()
      for (const r of rows) {
        const list = byObject.get(r.objectId) ?? []
        list.push({
          id: r.id,
          objectId: r.objectId,
          slug: r.slug,
          name: r.name,
          type: r.type,
          options: r.options,
          isSystem: r.isSystem,
          archived: r.archived,
          sortOrder: r.sortOrder,
        })
        byObject.set(r.objectId, list)
      }
      return byObject
    }),
  )

/** Stored values by slug, as a record or a brief member carries them. */
type Values = { readonly [slug: string]: unknown }

/** An option's place in the stage select, or null when unset or unknown. */
export const stageIndex = (
  defs: ReadonlyArray<AttributeDef>,
  values: Values,
): number | null => {
  const def = defs.find((d) => d.slug === STAGE_SLUG)
  const v = values[STAGE_SLUG]
  if (def === undefined || typeof v !== 'string') return null
  const at = (def.options.options ?? []).findIndex((o) => o.id === v)
  return at < 0 ? null : at
}

/** A company's key values as one line: `Funding stage: Seed · Location: Pune`. */
export const keyValuesLine = (
  defs: ReadonlyArray<AttributeDef>,
  values: Values,
): string =>
  BRIEF_KEY_SLUGS.flatMap((slug) => {
    const def = defs.find((d) => d.slug === slug)
    const text =
      def === undefined
        ? null
        : renderAttribute(def, values[slug], () => undefined)
    return text === null ? [] : [text]
  }).join(' · ')

const isUnder = (path: string, above: string) =>
  path !== above && path.startsWith(`${above}.`)

export const positionAndPeersProgram = Effect.fn('positionAndPeersProgram')(
  function* (
    seed: { id: string; objectId: string | null; values: EntityValues },
    filed: ReadonlyArray<FiledSpace>,
  ) {
    const out: Array<Candidate> = []
    if (filed.length === 0) return out

    // Every space at or above a filing, archived ones included, root first.
    const chain = yield* query(() =>
      db
        .select({
          id: space.entityId,
          path: space.path,
          name: entity.canonicalName,
          archived: sql<boolean>`${space.archivedAt} is not null`,
        })
        .from(space)
        .innerJoin(entity, eq(entity.id, space.entityId))
        .where(or(...filed.map((f) => sql`${space.path} @> ${f.path}`)))
        .orderBy(asc(sql`nlevel(${space.path})`), asc(space.path)),
    )

    // ---------- position ----------
    const live: Array<FiledSpace & { name: string }> = []
    for (const f of filed) {
      const above = chain.filter(
        (c) => c.path === f.path || isUnder(f.path, c.path),
      )
      if (above.some((c) => c.archived)) continue
      const self = above.find((c) => c.id === f.spaceId)
      if (self === undefined) continue
      live.push({ ...f, name: self.name })
      out.push({
        ref: ref.attr(f.spaceId, 'path'),
        kind: 'attribute',
        text: `Filed in: ${above.map((c) => c.name).join(' › ')}`,
        entityIds: [seed.id, f.spaceId],
        at: null,
        hop: 0,
      })
    }

    // ---------- peers: the leaf spaces' other companies ----------
    const leaves = live.filter(
      (f) => !live.some((g) => isUnder(g.path, f.path)),
    )
    if (leaves.length === 0) return out
    const leafName = new Map(leaves.map((l) => [l.spaceId, l.name]))
    const leafIds = leaves.map((l) => l.spaceId)

    // Stage order is the company object's funding stage select.
    const companyObject = (yield* query(() =>
      db
        .select({ id: objectDef.id })
        .from(objectDef)
        .where(eq(objectDef.slug, CORE_OBJECTS.company.slug)),
    )).at(0)
    const defs = yield* defsOfObjects(
      [seed.objectId, companyObject?.id ?? null].flatMap((id) =>
        id === null ? [] : [id],
      ),
    )
    const companyDefs =
      companyObject === undefined ? [] : (defs.get(companyObject.id) ?? [])
    const seedStage = stageIndex(
      seed.objectId === null ? [] : (defs.get(seed.objectId) ?? []),
      seed.values,
    )
    const stageIds = (
      companyDefs.find((d) => d.slug === STAGE_SLUG)?.options.options ?? []
    ).map((o) => o.id)

    // Ranked here as the ranker ranks them — nearest stage, newest, id — so
    // the cap keeps the right ones however large the leaf.
    const at = sql`coalesce((select max(${attributeEvent.at}) from ${attributeEvent} where ${attributeEvent.entityId} = ${entity.id}), ${entity.createdAt})`
    const distance =
      seedStage === null
        ? sql`null::int`
        : sql`abs(array_position(array[${sql.join(
            stageIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[], ${entity.values} ->> ${STAGE_SLUG}) - 1 - ${seedStage})`
    const rows = yield* query(() =>
      db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          values: entity.values,
          spaceId: sql<string>`(select ${entitySpace.spaceId} from ${entitySpace} where ${entitySpace.entityId} = ${entity.id} and ${inArray(entitySpace.spaceId, leafIds)} order by ${entitySpace.spaceId} limit 1)`,
          at: at.mapWith(entity.createdAt),
        })
        .from(entity)
        .where(
          and(
            eq(entity.kind, 'company'),
            isNull(entity.mergedIntoId),
            ne(entity.id, seed.id),
            sql`exists (select 1 from ${entitySpace} where ${entitySpace.entityId} = ${entity.id} and ${inArray(entitySpace.spaceId, leafIds)})`,
          ),
        )
        .orderBy(sql`${distance} asc nulls last`, desc(at), asc(entity.id))
        .limit(PEER_MAX),
    )
    for (const r of rows) {
      const stage = stageIndex(companyDefs, r.values)
      const line = keyValuesLine(companyDefs, r.values)
      out.push({
        ref: ref.attr(r.id, 'peer'),
        kind: 'attribute',
        text: `Peer in ${leafName.get(r.spaceId) ?? 'the same space'}: ${r.name}${line === '' ? '' : ` — ${line}`}`,
        entityIds: [seed.id, r.id],
        at: r.at.toISOString(),
        hop: 1,
        edge: 'peer',
        stageDistance:
          stage === null || seedStage === null
            ? null
            : Math.abs(stage - seedStage),
      })
    }
    return out
  },
)
