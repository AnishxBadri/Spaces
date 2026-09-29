import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { readEmbeddingPinProgram } from '#/lib/ai/embedding-pin'
import { canReadNoteSql } from '#/lib/search/query'
import { ContextQueryFailed } from '@spaces/core/context/errors'
import type { Candidate } from '@spaces/core/context/rank'
import { ref } from '@spaces/core/context/ref'
import { truncate } from '@spaces/core/context/render'

/**
 * The judgment-memory lane (SPA-139; docs/spec-ai-substrate.md §1 — "rank
 * close_reasons, pass/lost notes … of _similar_ records"). Every other lane
 * of the assembler walks outward from the seed; this one reaches sideways,
 * to what the fund decided about records that read like this one. The
 * mandate says what you claim to want; close_reasons say what you do.
 *
 * - **Anchor.** The centroid (`avg(embedding)`, computed in SQL — pgvector
 *   defines `avg` over `vector`) of the record's own embedded chunks under
 *   the pinned model: chunks on the record itself (its attribute chunks),
 *   and the chunks of the documents and notes filed (`tagged_in`) on it. For
 *   a company, the deals linked to it join the anchor set, so their
 *   close_reasons and notes shape it too. canRead holds here as well: a
 *   teammate's private note does not steer the anchor, or its content would
 *   leak through what ranks. No chunks, no anchor, no lane.
 * - **Candidates.** Other records only: a deal's `close_reason` attribute
 *   chunk, whatever the deal's stage, and the chunks of notes filed on a deal
 *   that was **passed or lost** — the spec's "pass/lost notes". Keyed on the
 *   registry's option ids for those two stages ({@link PASS_LOST_STAGES};
 *   `deal.stage` in `packages/core/src/attributes/registry.ts`), not on a
 *   label a user can rename. `invested` shares their `closed` group but is
 *   left out: a note on a deal the fund backed is not a pass reason, and it
 *   would dilute the lane. The anchor set is excluded, and so is any note
 *   filed on it.
 * - **canRead in SQL**, the same `canReadNoteSql` predicate search takes: a
 *   note chunk's entity is the note, so a teammate's private pass note never
 *   ranks. A close_reason chunk's entity is the deal, which carries no
 *   visibility flag, so the predicate is vacuous for it.
 * - **Stale rows** (another model's `embedding_model`) are skipped, exactly
 *   as SPA-129's lane skips them: garbage in this vector space.
 *
 * **No pin, no lane — and no lexical fallback.** A lexical "similar company"
 * matches words, not judgment: two decks that both say "AI platform" or
 * "B2B SaaS" share every buzzword and nothing a partner decided on, so a
 * word-overlap neighbour would hand the model a confident-looking but
 * arbitrary pass reason and the answer would cite it as precedent. An empty
 * lane says "no memory here"; a wrong neighbour says "you passed on this
 * before" when you did not. Nothing is better than that.
 */

/**
 * How far sideways is far enough. Both are **first guesses to tune on real
 * data** (the hitl half of SPA-139): five items is a paragraph of precedent,
 * not a report, and cosine distance 0.35 is "clearly about the same kind of
 * thing" for the 768-wide models the pin allows — loose enough that a
 * reworded pass reason still lands, tight enough that an unrelated deal's
 * does not. The budget slice (`SIMILAR_SHARE`, `rank.ts`) bounds the lane's
 * cost; these bound its reach, which the slice cannot.
 */
export const SIMILAR_TOP_N = 5
export const SIMILAR_MAX_DISTANCE = 0.35

/**
 * Chunks the index hands back before the record filters apply. Several
 * chunks of one note collapse into one item, and the stage and anchor
 * filters drop more, so this sits well above {@link SIMILAR_TOP_N}.
 */
const INNER_LIMIT = 100

/** How long a similar note's chunk may run in the item's text. */
const CHUNK_TEXT_MAX = 1200

export type SimilarInput = {
  userId: string
  /** The seed and, for a company, the deals linked to it. */
  anchorIds: ReadonlyArray<string>
}

type SimilarRow = {
  entity_id: string
  source_kind: 'note' | 'attribute'
  distance: number
  text: string
  deal_id: string
  deal_name: string
  stage_label: string | null
  note_title: string | null
  note_visibility: string | null
  note_author_id: string | null
  note_updated_at: string | null
}

export type SimilarCandidate = Candidate & {
  /** The note row behind a note item, for the assembler's output invariant. */
  noteRow: { entityId: string; visibility: string; authorId: string } | null
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ContextQueryFailed({ cause }),
  })

const uuidArray = (ids: ReadonlyArray<string>) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`

/**
 * The `deal.stage` option ids that record a no — ours (`passed`) or theirs
 * (`lost`). The registry gives no flag that tells them from `invested` (all
 * three sit in the `closed` group), so the ids are the key; ids are fixed at
 * seed time, labels are the user's to rename.
 */
export const PASS_LOST_STAGES: ReadonlyArray<string> = ['passed', 'lost']

/**
 * A deal's stage label, when its stage is in the `closed` option group —
 * and, with `passLostOnly`, only when that stage is passed or lost. The
 * close_reason half reads it for the label alone, so it takes any closed
 * stage; the note half filters on it, so it takes pass/lost only.
 */
const terminalStageLabel = (deal: string, passLostOnly = false) => sql`(
  select o ->> 'label'
  from attribute a, jsonb_array_elements(a.options -> 'options') o
  where a.object_id = ${sql.raw(deal)}.object_id
    and a.slug = 'stage'
    and o ->> 'group' = 'closed'
    and o ->> 'id' = ${sql.raw(deal)}.values ->> 'stage'
    ${
      passLostOnly
        ? sql`and o ->> 'id' in (${sql.join(
            PASS_LOST_STAGES.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``
    }
  limit 1
)`

/**
 * The anchor: the mean of the record's own readable chunks, as pgvector's
 * text form, or null when it has none under the pinned model.
 */
const anchorStatement = (
  { userId, anchorIds }: SimilarInput,
  model: string,
) => sql`
  select avg(c.embedding)::text as v
  from chunk c
  join entity e on e.id = c.entity_id and e.merged_into_id is null
  where c.embedding is not null
    and c.embedding_model = ${model}
    and ${canReadNoteSql(userId)}
    and (
      c.entity_id = any(${uuidArray(anchorIds)})
      or (
        c.source_kind in ('document', 'note')
        and exists (
          select 1 from link l
          where l.from_entity_id = c.entity_id
            and l.relation = 'tagged_in'
            and l.to_entity_id = any(${uuidArray(anchorIds)})
        )
      )
    )
`

/**
 * The neighbours. The inner subquery is SPA-129's shape — a bare
 * `order by embedding <=> <constant> limit n` the HNSW index can walk —
 * with the source filter inside it and `hnsw.iterative_scan` on for the
 * statement (`relaxed_order`, pgvector ≥ 0.8), so the index keeps walking
 * past document chunks until it has found `INNER_LIMIT` close_reason and
 * note chunks, instead of handing back its first `ef_search` rows and
 * leaving the filter nothing. The outer query re-sorts by exact distance,
 * so the relaxed order never reaches the ranking.
 */
const neighboursStatement = (
  { userId, anchorIds }: SimilarInput,
  model: string,
  anchor: string,
) => sql`
  with qv as (
    select ${anchor}::vector as v
  ),
  near as (
    select ch.entity_id, ch.source_kind, ch.idx, ch.text,
           ch.embedding <=> (select v from qv) as distance
    from chunk ch
    where ch.embedding_model = ${model}
      and (
        (ch.source_kind = 'attribute' and ch.source_key = 'close_reason')
        or ch.source_kind = 'note'
      )
    order by ch.embedding <=> (select v from qv)
    limit ${INNER_LIMIT}
  ),
  hits as (
    -- a close_reason on another deal
    select c.entity_id, c.source_kind, c.idx, c.text, c.distance,
           e.id as deal_id, e.canonical_name as deal_name,
           ${terminalStageLabel('e')} as stage_label,
           null::text as note_title, null::text as note_visibility,
           null::text as note_author_id, null::timestamptz as note_updated_at
    from near c
    join entity e on e.id = c.entity_id and e.merged_into_id is null
    where c.source_kind = 'attribute'
      and e.kind = 'deal'
      and c.distance <= ${SIMILAR_MAX_DISTANCE}
      and not (e.id = any(${uuidArray(anchorIds)}))
    union all
    -- a readable note filed on another deal that was passed or lost
    select c.entity_id, c.source_kind, c.idx, c.text, c.distance,
           d.id, d.canonical_name, ${terminalStageLabel('d', true)},
           n.title, n.visibility::text, n.author_id, n.updated_at
    from near c
    join entity e on e.id = c.entity_id and e.merged_into_id is null
    join note n on n.entity_id = e.id
    join lateral (
      select d.id, d.canonical_name, d.object_id, d.values
      from link l
      join entity d on d.id = l.to_entity_id
        and d.kind = 'deal' and d.merged_into_id is null
      where l.from_entity_id = e.id
        and l.relation = 'tagged_in'
        and ${terminalStageLabel('d', true)} is not null
      order by d.id
      limit 1
    ) d on true
    where c.source_kind = 'note'
      and c.distance <= ${SIMILAR_MAX_DISTANCE}
      and ${canReadNoteSql(userId)}
      and not exists (
        select 1 from link la
        where la.from_entity_id = e.id
          and la.to_entity_id = any(${uuidArray(anchorIds)})
      )
  )
  select distinct on (entity_id, source_kind)
         entity_id, source_kind, distance, text, deal_id, deal_name,
         stage_label, note_title, note_visibility, note_author_id,
         note_updated_at
  from hits
  order by entity_id, source_kind, distance, idx
`

/** Nearest first; equal distances by id, so the lane is deterministic. */
const byDistance = (a: SimilarRow, b: SimilarRow) =>
  a.distance - b.distance ||
  (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0)

const iso = (v: string | null): string | null =>
  v === null ? null : new Date(v).toISOString()

function toCandidate(r: SimilarRow): SimilarCandidate {
  const stage = r.stage_label ? ` (${r.stage_label})` : ''
  const similarity = 1 - Number(r.distance)
  const text = r.text.replace(/\s+/g, ' ').trim()
  if (r.source_kind === 'attribute')
    return {
      ref: ref.attr(r.deal_id, 'close_reason'),
      kind: 'attribute',
      text: `Similar judgment — close reason on ${r.deal_name}${stage}: ${text}`,
      entityIds: [r.deal_id],
      at: null,
      hop: 'similar',
      similarity,
      noteRow: null,
    }
  return {
    ref: ref.note(r.entity_id),
    kind: 'note',
    text: `Similar judgment — note on ${r.deal_name}${stage}: ${r.note_title ?? ''}\n${truncate(text, CHUNK_TEXT_MAX)}`,
    entityIds: [r.entity_id, r.deal_id],
    at: iso(r.note_updated_at),
    hop: 'similar',
    similarity,
    noteRow:
      r.note_visibility !== null && r.note_author_id !== null
        ? {
            entityId: r.entity_id,
            visibility: r.note_visibility,
            authorId: r.note_author_id,
          }
        : null,
  }
}

/**
 * The lane's candidates, nearest first, before the caller's dedupe against
 * the other lanes and the top-N cut. Empty with no pin, no anchor set, or
 * no embedded chunk on the anchor.
 */
export const similarCandidatesProgram = Effect.fn('similarCandidatesProgram')(
  function* (
    input: SimilarInput,
  ): Effect.fn.Return<Array<SimilarCandidate>, ContextQueryFailed> {
    if (input.anchorIds.length === 0) return []
    const pin = yield* readEmbeddingPinProgram().pipe(
      Effect.mapError((e) => new ContextQueryFailed({ cause: e })),
    )
    // No pin: nothing is embedded in a space anyone can compare in, and the
    // lane says nothing rather than guess by words (see the module comment).
    if (pin === null) return []

    const anchor = (yield* query(() =>
      db.execute<{ v: string | null }>(anchorStatement(input, pin.model)),
    )).rows.at(0)?.v
    if (anchor == null) return []

    const rows = yield* query(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
        return (
          await tx.execute<SimilarRow>(
            neighboursStatement(input, pin.model, anchor),
          )
        ).rows
      }),
    )
    return rows
      .map((r) => ({ ...r, distance: Number(r.distance) }))
      .sort(byDistance)
      .map(toCandidate)
  },
)
