import { Effect, Schema } from 'effect'
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  attribute,
  attributeEvent,
  document,
  documentChunk,
  entity,
  entityAlias,
  entitySpace,
  enrichmentRecord,
  link,
  mandate,
  note,
  signal,
  space,
  term,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { interaction, interactionEntity } from '@spaces/db/schema/interactions'
import {
  distribution,
  holding,
  investment,
  mark,
  round,
} from '@spaces/db/schema/portfolio'
import { task, taskEntity } from '@spaces/db/schema/tasks'
import type { AttributeDef } from '#/lib/attributes/registry'
import { fmtMoney } from '#/lib/portfolio/format'
import { canRead } from '#/lib/server/shared'
import { rank } from './rank'
import type { Candidate, RankResult } from './rank'
import { ref } from './ref'
import { renderAttribute, renderEvent, truncate } from './render'
import type { ContextEdge } from './types'

/**
 * The assembler, fetch half (docs/spec-ai-substrate.md §1; Effect-first per
 * CONTEXT.md "Backend paradigm"). Walks the graph from one record, renders
 * every row it finds to a Candidate, and hands the list to the pure ranker.
 *
 * canRead is enforced in SQL (CONTEXT.md: private-note filters live in the
 * queries) — a teammate's private note never enters the ranker. The output
 * stage re-checks as an invariant; a hit there means a fetch lost its
 * filter and is a bug, not a policy decision.
 *
 * Deterministic on (data, asOf, user). No Date.now(), and every fetch is
 * ordered so the ranker's first-wins dedupe sees a stable input.
 */

export class ContextQueryFailed extends Schema.TaggedError<ContextQueryFailed>()(
  'ContextQueryFailed',
  { cause: Schema.Defect() },
) {}

export class ContextEntityNotFound extends Schema.TaggedError<ContextEntityNotFound>()(
  'ContextEntityNotFound',
  { id: Schema.String, message: Schema.String },
) {}

export class ContextLeak extends Schema.TaggedError<ContextLeak>()(
  'ContextLeak',
  { ref: Schema.String, message: Schema.String },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ContextQueryFailed({ cause }),
  })

export type AssembleScope = { entityId: string }

export type AssembleOptions = {
  user: { id: string }
  /** ISO 8601 — the only clock. */
  asOf: string
  budgetChars: number
  /** Task text; enables the lexical lane and glossary matching. */
  taskText?: string | undefined
}

export type AssembleResult = RankResult & {
  /** The record actually assembled (after any merge redirect). */
  seed: { id: string; kind: string; name: string }
}

const NOTE_MAX = 2000
const EVENTS_MAX = 25
const INTERACTIONS_MAX = 25
const TASKS_MAX = 25
const CHUNKS_PER_DOC = 12

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : typeof d === 'string' ? d : d.toISOString()

const edgeOf = (relation: string): ContextEdge =>
  relation === 'references' ||
  relation === 'tagged_in' ||
  relation === 'mentions' ||
  relation === 'contact_at' ||
  relation === 'derived_from' ||
  relation === 'supersedes'
    ? relation
    : 'mentions'

export const assembleProgram = Effect.fn('assembleProgram')(function* (
  scope: AssembleScope,
  opts: AssembleOptions,
): Effect.fn.Return<
  AssembleResult,
  ContextQueryFailed | ContextEntityNotFound | ContextLeak
> {
  const userId = opts.user.id
  const readable = or(eq(note.visibility, 'shared'), eq(note.authorId, userId))

  // ---------- seed (follow a merge redirect, one hop) ----------
  let seed = (yield* query(() =>
    db
      .select({
        id: entity.id,
        kind: entity.kind,
        objectId: entity.objectId,
        name: entity.canonicalName,
        values: entity.values,
        mergedIntoId: entity.mergedIntoId,
      })
      .from(entity)
      .where(eq(entity.id, scope.entityId)),
  )).at(0)
  if (seed?.mergedIntoId) {
    seed = (yield* query(() =>
      db
        .select({
          id: entity.id,
          kind: entity.kind,
          objectId: entity.objectId,
          name: entity.canonicalName,
          values: entity.values,
          mergedIntoId: entity.mergedIntoId,
        })
        .from(entity)
        .where(eq(entity.id, seed!.mergedIntoId!)),
    )).at(0)
  }
  if (!seed)
    return yield* new ContextEntityNotFound({
      id: scope.entityId,
      message: 'Record not found',
    })
  const seedId = seed.id
  const candidates: Array<Candidate> = []
  // note visibility rows we let through, for the output invariant
  const noteRows = new Map<string, { visibility: string; authorId: string }>()

  // ---------- hop 0: attributes ----------
  const values = seed.values
  const objectId = seed.objectId
  const defs: Array<AttributeDef> = objectId
    ? (yield* query(() =>
        db
          .select()
          .from(attribute)
          .where(
            and(
              eq(attribute.objectId, objectId),
              eq(attribute.archived, false),
            ),
          )
          .orderBy(asc(attribute.sortOrder), asc(attribute.slug)),
      )).map((r) => ({
        id: r.id,
        objectId: r.objectId,
        slug: r.slug,
        name: r.name,
        type: r.type,
        options: r.options,
        isSystem: r.isSystem,
        archived: r.archived,
        sortOrder: r.sortOrder,
      }))
    : []

  // names for record + actor references, one fetch each
  const refIds = new Set<string>()
  const actorIds = new Set<string>()
  for (const d of defs) {
    const v = values[d.slug]
    if (v == null) continue
    const ids = (Array.isArray(v) ? v : [v]).map(String)
    if (d.type === 'record_reference') ids.forEach((i) => refIds.add(i))
    if (d.type === 'actor_reference') ids.forEach((i) => actorIds.add(i))
  }
  const names = new Map<string, string>()
  if (refIds.size > 0)
    for (const r of yield* query(() =>
      db
        .select({ id: entity.id, name: entity.canonicalName })
        .from(entity)
        .where(inArray(entity.id, [...refIds])),
    ))
      names.set(r.id, r.name)
  const userNames = new Map<string, string>()
  for (const u of yield* query(() =>
    db.select({ id: user.id, name: user.name }).from(user),
  ))
    userNames.set(u.id, u.name)
  actorIds.forEach((id) => {
    const n = userNames.get(id)
    if (n) names.set(id, n)
  })
  const lookup = (id: string) => names.get(id)

  const attrText: Array<string> = []
  for (const d of defs) {
    const text = renderAttribute(d, values[d.slug], lookup)
    if (text == null) continue
    attrText.push(text)
    candidates.push({
      ref: ref.attr(seedId, d.slug),
      kind: 'attribute',
      text,
      entityIds: [seedId],
      at: null,
      hop: 0,
    })
  }

  // identity aliases are facts about the record too
  for (const a of yield* query(() =>
    db
      .select({ kind: entityAlias.kind, value: entityAlias.valueNorm })
      .from(entityAlias)
      .where(
        and(eq(entityAlias.entityId, seedId), eq(entityAlias.isIdentity, true)),
      )
      .orderBy(asc(entityAlias.kind), asc(entityAlias.valueNorm)),
  )) {
    const text = `${a.kind}: ${a.value}`
    attrText.push(text)
    candidates.push({
      ref: ref.attr(seedId, `alias.${a.kind}`),
      kind: 'attribute',
      text,
      entityIds: [seedId],
      at: null,
      hop: 0,
    })
  }

  // ---------- hop 0: history ----------
  const defName = (slug: string) =>
    defs.find((d) => d.slug === slug)?.name ?? slug
  for (const ev of yield* query(() =>
    db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, seedId))
      .orderBy(desc(attributeEvent.at), asc(attributeEvent.id))
      .limit(EVENTS_MAX),
  )) {
    const actor =
      ev.actorType === 'user'
        ? (userNames.get(ev.actorId ?? '') ?? 'someone')
        : ev.actorType
    const at = ev.at.toISOString()
    candidates.push({
      ref: ref.event(ev.id),
      kind: 'event',
      text: renderEvent(defName(ev.attrSlug), ev.from, ev.to, actor, at),
      entityIds: [seedId],
      at,
      hop: 0,
    })
  }
  for (const s of yield* query(() =>
    db
      .select()
      .from(signal)
      .where(eq(signal.entityId, seedId))
      .orderBy(desc(signal.observedAt), asc(signal.id))
      .limit(EVENTS_MAX),
  )) {
    candidates.push({
      ref: ref.event(s.id),
      kind: 'event',
      text: `Signal (${s.source}): ${truncate(JSON.stringify(s.payload), 300)}`,
      entityIds: [seedId],
      at: s.observedAt.toISOString(),
      hop: 0,
    })
  }
  for (const e of yield* query(() =>
    db
      .select({
        id: enrichmentRecord.id,
        provider: enrichmentRecord.provider,
        at: enrichmentRecord.fetchedAt,
      })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.entityId, seedId))
      .orderBy(desc(enrichmentRecord.fetchedAt), asc(enrichmentRecord.id))
      .limit(EVENTS_MAX),
  )) {
    candidates.push({
      ref: ref.event(e.id),
      kind: 'event',
      text: `Enriched via ${e.provider} on ${e.at.toISOString().slice(0, 10)}`,
      entityIds: [seedId],
      at: e.at.toISOString(),
      hop: 0,
    })
  }

  // ---------- hop 0: portfolio ledger ----------
  for (const r of yield* query(() =>
    db
      .select()
      .from(round)
      .where(eq(round.companyId, seedId))
      .orderBy(asc(round.date), asc(round.id)),
  )) {
    const raised =
      r.raised != null ? fmtMoney(Number(r.raised), r.currency ?? 'USD') : null
    candidates.push({
      ref: ref.event(r.id),
      kind: 'event',
      text: `Round ${r.kind} on ${r.date}${raised ? `: raised ${raised}` : ''}`,
      entityIds: [seedId],
      at: r.date,
      hop: 0,
    })
  }
  const h = (yield* query(() =>
    db
      .select({ id: holding.id })
      .from(holding)
      .where(eq(holding.companyId, seedId)),
  )).at(0)
  if (h) {
    for (const i of yield* query(() =>
      db
        .select()
        .from(investment)
        .where(eq(investment.holdingId, h.id))
        .orderBy(asc(investment.date), asc(investment.id)),
    ))
      candidates.push({
        ref: ref.event(i.id),
        kind: 'event',
        text: `Invested ${fmtMoney(Number(i.amount), i.currency)} (${i.instrument}) on ${i.date}`,
        entityIds: [seedId],
        at: i.date,
        hop: 0,
      })
    for (const m of yield* query(() =>
      db
        .select()
        .from(mark)
        .where(eq(mark.holdingId, h.id))
        .orderBy(asc(mark.date), asc(mark.id)),
    ))
      candidates.push({
        ref: ref.event(m.id),
        kind: 'event',
        text: `Marked at ${fmtMoney(Number(m.fairValue), m.currency)} (${m.basis}) on ${m.date}`,
        entityIds: [seedId],
        at: m.date,
        hop: 0,
      })
    for (const d of yield* query(() =>
      db
        .select()
        .from(distribution)
        .where(eq(distribution.holdingId, h.id))
        .orderBy(asc(distribution.date), asc(distribution.id)),
    ))
      candidates.push({
        ref: ref.event(d.id),
        kind: 'event',
        text: `Distribution ${d.kind}: ${fmtMoney(Number(d.amount), d.currency)} on ${d.date}`,
        entityIds: [seedId],
        at: d.date,
        hop: 0,
      })
  }

  // ---------- hop 1: links, both directions ----------
  const links = yield* query(() =>
    db
      .select()
      .from(link)
      .where(or(eq(link.fromEntityId, seedId), eq(link.toEntityId, seedId)))
      .orderBy(asc(link.relation), asc(link.id)),
  )
  const otherIds = [
    ...new Set(
      links.map((l) =>
        l.fromEntityId === seedId ? l.toEntityId : l.fromEntityId,
      ),
    ),
  ]
  const others = new Map<string, { kind: string; name: string }>()
  if (otherIds.length > 0)
    for (const o of yield* query(() =>
      db
        .select({
          id: entity.id,
          kind: entity.kind,
          name: entity.canonicalName,
        })
        .from(entity)
        .where(inArray(entity.id, otherIds)),
    ))
      others.set(o.id, { kind: o.kind, name: o.name })

  const noteIds = otherIds.filter((id) => others.get(id)?.kind === 'note')
  const docIds = otherIds.filter((id) => others.get(id)?.kind === 'document')

  // notes + memos — canRead in SQL
  const notesById = new Map<string, typeof note.$inferSelect>()
  if (noteIds.length > 0)
    for (const n of yield* query(() =>
      db
        .select()
        .from(note)
        .where(and(inArray(note.entityId, noteIds), readable)),
    ))
      notesById.set(n.entityId, n)

  // documents + chunks
  const docsById = new Map<
    string,
    { filename: string | null; kind: string; createdAt: Date }
  >()
  if (docIds.length > 0)
    for (const d of yield* query(() =>
      db
        .select({
          id: document.entityId,
          filename: document.filename,
          kind: document.kind,
          createdAt: document.createdAt,
        })
        .from(document)
        .where(inArray(document.entityId, docIds)),
    ))
      docsById.set(d.id, d)
  const chunks = docIds.length
    ? yield* query(() =>
        db
          .select({
            docId: documentChunk.documentId,
            idx: documentChunk.idx,
            text: documentChunk.text,
            lex: opts.taskText
              ? sql<number>`ts_rank(to_tsvector('english', ${documentChunk.text}), plainto_tsquery('english', ${opts.taskText}))`
              : sql<number>`0`,
          })
          .from(documentChunk)
          .where(inArray(documentChunk.documentId, docIds))
          .orderBy(asc(documentChunk.documentId), asc(documentChunk.idx)),
      )
    : []
  // lexical lane: rank chunks with a positive score; ties by doc, idx
  const lexRank = new Map<string, number>()
  if (opts.taskText) {
    const hits = chunks
      // ts_rank reports 1e-20, not 0, for a miss
      .filter((c) => Number(c.lex) > 1e-9)
      .sort(
        (a, b) =>
          Number(b.lex) - Number(a.lex) ||
          a.docId.localeCompare(b.docId) ||
          a.idx - b.idx,
      )
    hits.forEach((c, i) => lexRank.set(ref.doc(c.docId, c.idx), i + 1))
  }

  const seenDocs = new Set<string>()
  for (const l of links) {
    const otherId = l.fromEntityId === seedId ? l.toEntityId : l.fromEntityId
    const other = others.get(otherId)
    if (!other) continue
    const edge = edgeOf(l.relation)
    switch (other.kind) {
      case 'note': {
        const n = notesById.get(otherId)
        if (!n) continue // private-and-not-mine, or gone
        noteRows.set(otherId, {
          visibility: n.visibility,
          authorId: n.authorId,
        })
        const isMemo = n.kind === 'memo'
        const body = truncate(n.bodyMd, NOTE_MAX)
        candidates.push({
          ref: isMemo ? ref.memo(otherId) : ref.note(otherId),
          kind: isMemo ? 'memo' : 'note',
          text: `${isMemo ? 'Memo' : 'Note'}: ${n.title}${body ? `\n${body}` : ''}`,
          entityIds: [seedId, otherId],
          at: n.updatedAt.toISOString(),
          hop: 1,
          edge,
        })
        break
      }
      case 'document': {
        if (seenDocs.has(otherId)) break
        seenDocs.add(otherId)
        const d = docsById.get(otherId)
        if (!d) break
        const label = d.filename ?? other.name
        const mine = chunks.filter((c) => c.docId === otherId)
        const pick = opts.taskText
          ? mine
              .filter((c) => lexRank.has(ref.doc(c.docId, c.idx)))
              .concat(mine.filter((c) => !lexRank.has(ref.doc(c.docId, c.idx))))
              .slice(0, CHUNKS_PER_DOC)
          : mine.slice(0, CHUNKS_PER_DOC)
        for (const c of pick) {
          const r = ref.doc(otherId, c.idx)
          candidates.push({
            ref: r,
            kind: 'doc_chunk',
            text: `${label} [${d.kind}] p.${c.idx + 1}: ${c.text}`,
            entityIds: [seedId, otherId],
            at: d.createdAt.toISOString(),
            hop: 1,
            edge,
            lexicalRank: lexRank.get(r),
          })
        }
        break
      }
      case 'space':
      case 'term':
        break // spaces via entity_space below; terms via task text
      default: {
        // a linked record: the reference line, or the contact/mention name
        if (l.relation === 'references' && l.fromEntityId === seedId) break // already an attribute
        const label =
          l.relation === 'references'
            ? `Referenced by ${other.kind}: ${other.name} (${l.attrSlug})`
            : l.relation === 'contact_at'
              ? `${other.kind === 'person' ? 'Contact' : 'Company'}: ${other.name}`
              : `${other.kind}: ${other.name}`
        candidates.push({
          ref: ref.attr(
            otherId,
            l.relation === 'references' ? l.attrSlug : l.relation,
          ),
          kind: 'attribute',
          text: label,
          entityIds: [seedId, otherId],
          at: null,
          hop: 1,
          edge,
        })
      }
    }
  }

  // ---------- hop 1/2: spaces → memos up the tree ----------
  const tags = yield* query(() =>
    db
      .select({ spaceId: entitySpace.spaceId, path: space.path })
      .from(entitySpace)
      .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
      .where(eq(entitySpace.entityId, seedId))
      .orderBy(asc(space.path)),
  )
  if (tags.length > 0) {
    const chain = yield* query(() =>
      db
        .select({ id: space.entityId, path: space.path })
        .from(space)
        .where(or(...tags.map((t) => sql`${space.path} @> ${t.path}`)))
        .orderBy(asc(space.path)),
    )
    const direct = new Set(tags.map((t) => t.spaceId))
    const spaceIds = chain.map((s) => s.id)
    const memos = spaceIds.length
      ? yield* query(() =>
          db
            .select({ spaceId: link.toEntityId, n: note })
            .from(link)
            .innerJoin(note, eq(note.entityId, link.fromEntityId))
            .where(
              and(
                inArray(link.toEntityId, spaceIds),
                eq(link.relation, 'tagged_in'),
                eq(note.kind, 'memo'),
                readable,
              ),
            )
            .orderBy(asc(link.toEntityId), asc(note.entityId)),
        )
      : []
    for (const m of memos) {
      noteRows.set(m.n.entityId, {
        visibility: m.n.visibility,
        authorId: m.n.authorId,
      })
      candidates.push({
        ref: ref.memo(m.n.entityId),
        kind: 'memo',
        text: `Memo: ${m.n.title}\n${truncate(m.n.bodyMd, NOTE_MAX)}`,
        entityIds: [m.spaceId, m.n.entityId],
        at: m.n.updatedAt.toISOString(),
        hop: direct.has(m.spaceId) ? 1 : 2,
        edge: 'space',
      })
    }
  }

  // ---------- hop 1: interactions + tasks ----------
  for (const i of yield* query(() =>
    db
      .select({ i: interaction })
      .from(interactionEntity)
      .innerJoin(
        interaction,
        eq(interaction.id, interactionEntity.interactionId),
      )
      .where(eq(interactionEntity.entityId, seedId))
      .orderBy(desc(interaction.occurredAt), asc(interaction.id))
      .limit(INTERACTIONS_MAX),
  )) {
    const at = i.i.occurredAt.toISOString()
    candidates.push({
      ref: ref.interaction(i.i.id),
      kind: 'interaction',
      text: `${i.i.kind} on ${at.slice(0, 10)}${i.i.subject ? `: ${i.i.subject}` : ''}`,
      entityIds: [seedId],
      at,
      hop: 1,
      edge: 'mentions',
    })
  }
  for (const t of yield* query(() =>
    db
      .select({ t: task })
      .from(taskEntity)
      .innerJoin(task, eq(task.id, taskEntity.taskId))
      .where(eq(taskEntity.entityId, seedId))
      .orderBy(asc(task.dueDate), asc(task.id))
      .limit(TASKS_MAX),
  )) {
    const status = t.t.doneAt ? 'done' : 'open'
    candidates.push({
      ref: ref.task(t.t.id),
      kind: 'task',
      text: `Task (${status}${t.t.dueDate ? `, due ${t.t.dueDate}` : ''}): ${t.t.content}`,
      entityIds: [seedId],
      at: iso(t.t.doneAt) ?? t.t.createdAt.toISOString(),
      hop: 1,
      edge: 'mentions',
    })
  }

  // ---------- standing: mandate + glossary ----------
  const m = (yield* query(() =>
    db
      .select({
        id: mandate.id,
        n: note,
        stages: mandate.stages,
        geos: mandate.geos,
        checkMin: mandate.checkMin,
        checkMax: mandate.checkMax,
        currency: mandate.currency,
      })
      .from(mandate)
      .innerJoin(note, eq(note.entityId, mandate.noteEntityId))
      .where(and(eq(mandate.status, 'active'), readable)),
  )).at(0)
  if (m) {
    noteRows.set(m.n.entityId, {
      visibility: m.n.visibility,
      authorId: m.n.authorId,
    })
    const cur = m.currency ?? 'USD'
    const check =
      m.checkMin != null || m.checkMax != null
        ? `Check ${m.checkMin != null ? fmtMoney(m.checkMin, cur) : '?'}–${m.checkMax != null ? fmtMoney(m.checkMax, cur) : '?'}.`
        : ''
    const head = [
      m.stages.length ? `Stages: ${m.stages.join(', ')}.` : '',
      m.geos.length ? `Geos: ${m.geos.join(', ')}.` : '',
      check,
    ]
      .filter(Boolean)
      .join(' ')
    candidates.push({
      ref: ref.mandate(m.id),
      kind: 'mandate',
      text: `Mandate: ${head}\n${truncate(m.n.bodyMd, NOTE_MAX)}`.trim(),
      entityIds: [],
      at: m.n.updatedAt.toISOString(),
      hop: 'standing',
    })
  }
  const haystack =
    `${opts.taskText ?? ''}\n${attrText.join('\n')}`.toLowerCase()
  for (const t of yield* query(() =>
    db.select().from(term).orderBy(asc(term.name), asc(term.entityId)),
  )) {
    const needles = [t.name, ...t.aliases]
      .map((s) => s.toLowerCase())
      .filter(Boolean)
    if (!needles.some((n) => haystack.includes(n))) continue
    candidates.push({
      ref: ref.term(t.entityId),
      kind: 'glossary',
      text: `${t.name}: ${truncate(t.definitionMd, 600)}`,
      entityIds: [t.entityId],
      at: null,
      hop: 'standing',
    })
  }

  // ---------- rank ----------
  const result = rank(candidates, {
    asOf: opts.asOf,
    budgetChars: opts.budgetChars,
  })

  // ---------- output invariant: nothing leaves that canRead would refuse ----------
  for (const item of result.items) {
    for (const id of item.entityIds) {
      const row = noteRows.get(id)
      if (row && !canRead(opts.user, row))
        return yield* new ContextLeak({
          ref: item.ref,
          message: 'canRead refused an assembled item',
        })
    }
  }

  return { ...result, seed: { id: seedId, kind: seed.kind, name: seed.name } }
})
