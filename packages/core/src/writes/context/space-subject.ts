import { Effect } from 'effect'
import { inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import type { SpaceBriefNode } from '@spaces/sdk'
import { ContextEntityNotFound } from '../../context/errors'
import type { ContextLeak, ContextQueryFailed } from '../../context/errors'
import type { Candidate, RankResult } from '../../context/rank'
import { ref } from '../../context/ref'
import { defsOfObjects, keyValuesLine, stageIndex } from './position'
import { spaceSubjectProgram } from './space-brief'
import { mandateCandidate, query, rankChecked, revealed } from './spaces'
import type { NoteGate } from './spaces'

/**
 * A space as the assembler's subject (D71): its path, subspace tree with
 * counts, companies grouped by stage, memos and terms, from the brief.
 * - Read as the asker: memos by `canRead`; nothing sensitive is cut, the
 *   result is marked sensitive instead and its egress gate decides.
 * - Every piece is a candidate, ranked and capped like any other.
 */

/** Tree lines shown before the rest is summed up. */
const TREE_LINES_MAX = 80
const NO_STAGE = 'No stage'

export type SpaceAssembly = RankResult & {
  seed: { id: string; kind: string; name: string }
  sensitive: boolean
  reveals: ReadonlyArray<string>
}

const treeLines = (node: SpaceBriefNode, depth = 0): Array<string> => [
  `${'  '.repeat(depth)}${node.name} · ${node.companies}`,
  ...node.children.flatMap((c) => treeLines(c, depth + 1)),
]

const treeIds = (node: SpaceBriefNode): Array<string> => [
  node.id,
  ...node.children.flatMap(treeIds),
]

export const assembleSpaceProgram = Effect.fn('assembleSpaceProgram')(
  function* (
    spaceId: string,
    opts: { user: { id: string }; asOf: string; budgetChars: number },
  ): Effect.fn.Return<
    SpaceAssembly,
    ContextQueryFailed | ContextEntityNotFound | ContextLeak
  > {
    const subject = yield* spaceSubjectProgram(spaceId, opts.user).pipe(
      Effect.catchTag('SpaceBriefRefused', () =>
        Effect.fail(
          new ContextEntityNotFound({
            id: spaceId,
            message: 'Space not found',
          }),
        ),
      ),
    )
    const { brief } = subject
    const candidates: Array<Candidate> = []
    const noteRows = new Map<string, NoteGate>()
    const id = brief.space.id

    // ---------- hop 0: where it is, what belongs, its shape ----------
    candidates.push({
      ref: ref.attr(id, 'path'),
      kind: 'attribute',
      text: `Space: ${brief.path.map((p) => p.name).join(' › ')}`,
      entityIds: [id],
      at: null,
      hop: 0,
    })
    if (brief.space.criteria !== null)
      candidates.push({
        ref: ref.attr(id, 'criteria'),
        kind: 'attribute',
        text: `Criteria: ${brief.space.criteria}`,
        entityIds: [id],
        at: null,
        hop: 0,
      })
    const lines = treeLines(brief.tree)
    candidates.push({
      ref: ref.attr(id, 'tree'),
      kind: 'attribute',
      text: [
        'Subspaces, with the companies filed on each:',
        ...lines.slice(0, TREE_LINES_MAX),
        ...(lines.length > TREE_LINES_MAX
          ? [`… ${lines.length - TREE_LINES_MAX} more`]
          : []),
      ].join('\n'),
      entityIds: treeIds(brief.tree),
      at: null,
      hop: 0,
    })

    // ---------- companies by stage ----------
    const objectIds = new Map<string, string | null>()
    if (brief.members.length > 0)
      for (const r of yield* query(() =>
        db
          .select({ id: entity.id, objectId: entity.objectId })
          .from(entity)
          .where(
            inArray(
              entity.id,
              brief.members.map((m) => m.entityId),
            ),
          ),
      ))
        objectIds.set(r.id, r.objectId)
    const defs = yield* defsOfObjects([
      ...new Set(
        [...objectIds.values()].flatMap((o) => (o === null ? [] : [o])),
      ),
    ])
    const defsOf = (memberId: string) => {
      const o = objectIds.get(memberId)
      return o === undefined || o === null ? [] : (defs.get(o) ?? [])
    }
    const spaceName = new Map<string, string>()
    const nameAll = (n: SpaceBriefNode): void => {
      spaceName.set(n.id, n.name)
      n.children.forEach(nameAll)
    }
    nameAll(brief.tree)
    const stageOf = (m: (typeof brief.members)[number]) => {
      const d = defsOf(m.entityId)
      const at = stageIndex(d, m.values)
      const def = d.find((x) => x.slug === 'funding_stage')
      const label =
        at === null ? NO_STAGE : (def?.options.options?.[at]?.label ?? NO_STAGE)
      return { at, label }
    }
    const groups = new Map<
      string,
      { at: number | null; names: Array<string> }
    >()
    for (const m of brief.members) {
      const s = stageOf(m)
      const g = groups.get(s.label) ?? { at: s.at, names: [] }
      g.names.push(m.name)
      groups.set(s.label, g)
    }
    const ordered = [...groups.entries()].sort(
      ([, a], [, b]) =>
        (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY),
    )
    candidates.push({
      ref: ref.attr(id, 'by_stage'),
      kind: 'attribute',
      text: [
        `Companies filed here and below, by stage (${brief.memberCount}${brief.memberCount > brief.members.length ? `, ${brief.members.length} shown` : ''}):`,
        ...ordered.map(([label, g]) => `${label}: ${g.names.join(', ')}`),
      ].join('\n'),
      entityIds: [id, ...brief.members.map((m) => m.entityId)],
      at: null,
      hop: 0,
    })
    for (const m of brief.members) {
      const line = keyValuesLine(defsOf(m.entityId), m.values)
      const where = spaceName.get(m.spaceId)
      candidates.push({
        ref: ref.attr(m.entityId, 'member'),
        kind: 'attribute',
        text: `${m.name}${where === undefined || m.spaceId === id ? '' : ` (in ${where})`}${line === '' ? '' : ` — ${line}`}`,
        entityIds: [id, m.entityId],
        at: null,
        hop: 1,
        edge: 'space',
      })
    }

    // ---------- memos: its own, then up the path ----------
    for (const memo of brief.memos) {
      const memoId = memo.ref.slice('memo:'.length)
      candidates.push({
        ref: memo.ref,
        kind: 'memo',
        text: `Memo: ${memo.title}\n${memo.body}`,
        entityIds: [memo.spaceId, memoId],
        at: memo.updatedAt,
        hop: memo.spaceId === id ? 1 : 2,
        edge: 'space',
      })
    }

    // ---------- standing: the mandate, and the path's terms ----------
    const mandate = yield* mandateCandidate(opts.user.id, noteRows)
    if (mandate !== null) candidates.push(mandate)
    for (const t of brief.terms)
      candidates.push({
        ref: t.ref,
        kind: 'glossary',
        text: `${t.name}: ${t.definition}`,
        entityIds: [t.ref.slice('term:'.length)],
        at: null,
        hop: 'standing',
      })

    const result = yield* rankChecked(candidates, noteRows, opts)
    return {
      ...result,
      seed: { id, kind: 'space', name: brief.space.name },
      sensitive: subject.sensitive,
      reveals: revealed(id, result.items, subject.reveals),
    }
  },
)
