import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * The one ref resolver (SPA-119), on this worker's test database — truncated
 * and reseeded before the file was imported (SPA-145), so the tests below
 * write what they like. A ref that names a merged loser lands on the winner
 * for every entity-bearing kind; a re-chunk keeps `doc:<id>#<idx>` on its
 * document; a deleted target resolves `missing` and nothing throws; the cost
 * is one query per ref kind, not per ref; and `cite.ts` is the only renderer.
 */

async function deps() {
  const { Effect } = await import('effect')
  const { eq } = await import('drizzle-orm')
  const { db } = await import('@spaces/db')
  const schema = await import('@spaces/db/schema')
  const { user } = await import('@spaces/db/schema/auth')
  const { resolveRefsProgram, MISSING_LABEL } = await import('./names')
  const { ref } = await import('./ref')
  const me = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!me) throw new Error('the test seed has no user')
  const resolve = (refs: ReadonlyArray<string>) =>
    Effect.runPromise(resolveRefsProgram(refs))

  const newEntity = async (
    kind: 'company' | 'note' | 'document' | 'term',
    name: string,
    mergedIntoId?: string,
  ) => {
    const row = (
      await db
        .insert(schema.entity)
        .values({
          kind,
          canonicalName: name,
          ...(mergedIntoId === undefined ? {} : { mergedIntoId }),
        })
        .returning({ id: schema.entity.id })
    ).at(0)
    if (!row) throw new Error('entity insert returned nothing')
    return row.id
  }
  const newNote = async (title: string, kind: 'note' | 'memo') => {
    const id = await newEntity('note', title)
    await db.insert(schema.note).values({
      entityId: id,
      title,
      bodyMd: '',
      kind,
      authorId: me.id,
      visibility: 'shared',
    })
    return id
  }
  const newDocument = async (filename: string) => {
    const id = await newEntity('document', `${filename} entity`)
    // Exempt from the one-writer rule: a fixture row, nothing to extract.
    await db.insert(schema.document).values({
      entityId: id,
      filename,
      kind: 'deck',
      sourceClass: 'manual',
      extractionStatus: 'done',
    })
    return id
  }
  const newTerm = async (name: string) => {
    const id = await newEntity('term', `${name} entity`)
    await db.insert(schema.term).values({ entityId: id, name })
    return id
  }
  /** A loser pointing at `winner`, of the winner's own kind. */
  const loserOf = async (
    kind: 'company' | 'note' | 'document' | 'term',
    winner: string,
  ) => newEntity(kind, 'Loser', winner)

  return {
    Effect,
    eq,
    db,
    schema,
    me,
    ref,
    resolve,
    MISSING_LABEL,
    newEntity,
    newNote,
    newDocument,
    newTerm,
    loserOf,
  }
}

describe('resolveRefs — merges', () => {
  it('follows merged_into_id to the survivor for attr, note, memo, doc and term', async () => {
    const d = await deps()
    const company = await d.newEntity('company', 'Acme Winner')
    const noteId = await d.newNote('Call notes', 'note')
    const memoId = await d.newNote('IC memo', 'memo')
    const docId = await d.newDocument('deck.pdf')
    const termId = await d.newTerm('ARR')

    const refs = [
      d.ref.attr(await d.loserOf('company', company), 'funding_stage'),
      d.ref.note(await d.loserOf('note', noteId)),
      d.ref.memo(await d.loserOf('note', memoId)),
      d.ref.doc(await d.loserOf('document', docId), 4),
      d.ref.term(await d.loserOf('term', termId)),
    ]
    const resolved = await d.resolve(refs)

    expect(resolved).toEqual([
      {
        ref: refs[0],
        entityId: company,
        label: 'Funding stage on Acme Winner',
        missing: false,
      },
      { ref: refs[1], entityId: noteId, label: 'Call notes', missing: false },
      { ref: refs[2], entityId: memoId, label: 'IC memo', missing: false },
      {
        ref: refs[3],
        entityId: docId,
        label: 'deck.pdf · chunk 4',
        missing: false,
      },
      { ref: refs[4], entityId: termId, label: 'ARR', missing: false },
    ])
  })

  it('reads the redirect without writing it — the loser row is untouched', async () => {
    const d = await deps()
    const winner = await d.newEntity('company', 'Kept Winner')
    const loser = await d.newEntity('company', 'Kept Loser', winner)
    await d.resolve([d.ref.note(loser)])
    const still = (
      await d.db
        .select({
          name: d.schema.entity.canonicalName,
          mergedIntoId: d.schema.entity.mergedIntoId,
        })
        .from(d.schema.entity)
        .where(d.eq(d.schema.entity.id, loser))
    ).at(0)
    expect(still).toEqual({ name: 'Kept Loser', mergedIntoId: winner })
  })

  it('names the mandate through its note and lands on that note', async () => {
    const d = await deps()
    const noteId = await d.newNote('Mandate', 'note')
    const m = (
      await d.db
        .insert(d.schema.mandate)
        .values({ noteEntityId: noteId })
        .returning({ id: d.schema.mandate.id })
    ).at(0)
    if (!m) throw new Error('mandate insert returned nothing')
    const [resolved] = await d.resolve([d.ref.mandate(m.id)])
    expect(resolved).toEqual({
      ref: d.ref.mandate(m.id),
      entityId: noteId,
      label: 'the mandate',
      missing: false,
    })
  })
})

describe('resolveRefs — re-chunk', () => {
  it('keeps doc:<id>#<idx> on the same document after a re-chunk; the index may now point at different text, and that is the accepted trade', async () => {
    const d = await deps()
    const docId = await d.newDocument('rechunked.pdf')
    const chunk = (idx: number, text: string) => ({
      entityId: docId,
      sourceKind: 'document' as const,
      idx,
      text,
    })
    await d.db
      .insert(d.schema.chunk)
      .values([0, 1, 2, 3, 4].map((i) => chunk(i, `first pass ${String(i)}`)))
    const stored = d.ref.doc(docId, 3)
    const before = await d.resolve([stored])

    // The re-chunk: every chunk gone, new boundaries in their place.
    await d.db
      .delete(d.schema.chunk)
      .where(d.eq(d.schema.chunk.entityId, docId))
    await d.db
      .insert(d.schema.chunk)
      .values([0, 1, 2, 3].map((i) => chunk(i, `second pass ${String(i)}`)))
    const after = await d.resolve([stored])

    expect(after).toEqual(before)
    expect(after).toEqual([
      {
        ref: stored,
        entityId: docId,
        label: 'rechunked.pdf · chunk 3',
        missing: false,
      },
    ])
  })
})

describe('resolveRefs — deleted targets', () => {
  it('resolves a deleted target to missing and throws nothing, for every kind', async () => {
    const d = await deps()
    const gone = await d.newEntity('company', 'Gone Co')
    const orphanWinner = await d.newEntity('company', 'Gone Winner')
    const orphanLoser = await d.newEntity('company', 'Orphan', orphanWinner)
    await d.db
      .delete(d.schema.entity)
      .where(d.eq(d.schema.entity.id, orphanWinner))
    await d.db.delete(d.schema.entity).where(d.eq(d.schema.entity.id, gone))
    const nobody = '00000000-0000-4000-8000-000000000000'

    const refs = [
      d.ref.attr(gone, 'stage'),
      d.ref.note(gone),
      d.ref.memo(gone),
      d.ref.doc(gone, 2),
      d.ref.term(gone),
      d.ref.mandate(nobody),
      // a loser whose survivor is gone lands nowhere either
      d.ref.note(orphanLoser),
    ]
    const resolved = await d.resolve(refs)
    expect(resolved).toEqual(
      refs.map((r) => ({
        ref: r,
        entityId: null,
        label: d.MISSING_LABEL,
        missing: true,
      })),
    )

    // refs that name no entity are labelled, not looked up
    expect(
      await d.resolve([d.ref.event(nobody), 'not-a-ref', 'doc:deck#p2']),
    ).toEqual([
      {
        ref: d.ref.event(nobody),
        entityId: null,
        label: 'record history',
        missing: false,
      },
      { ref: 'not-a-ref', entityId: null, label: 'not-a-ref', missing: false },
      {
        ref: 'doc:deck#p2',
        entityId: null,
        label: 'doc:deck#p2',
        missing: false,
      },
    ])
  })

  it('reaches /inbox and the record timeline as missing — neither consumer fails', async () => {
    const d = await deps()
    const { resolveEntity } = await import('#/lib/entities/resolve')
    const { proposeProgram, acceptProgram } = await import('#/lib/ai/propose')
    const { listInboxProgram } = await import('#/lib/inbox/queue')
    const { recordTimelineProgram } = await import('#/lib/timeline/record')

    const company = (
      await resolveEntity({
        kind: 'company',
        name: 'Cited Robotics',
        keys: { domain: 'cited-robotics.example' },
        source: { class: 'manual' },
      })
    ).entityId
    const source = await d.newEntity('company', 'Soon Gone')
    const cited = [d.ref.attr(source, 'location'), d.ref.note(source)]

    const open = await d.Effect.runPromise(
      proposeProgram({
        entityId: company,
        kind: 'attribute_patch',
        payload: {
          founded_year: { value: 2019, refs: cited, confidence: 0.8 },
        },
        rationale: 'read it off a record that will be deleted',
        proposedBy: { type: 'system' },
      }),
    )
    const accepted = await d.Effect.runPromise(
      proposeProgram({
        entityId: company,
        kind: 'attribute_patch',
        payload: {
          location: { value: 'Berlin', refs: cited, confidence: 0.8 },
        },
        rationale: 'accepted, so its refs reach attribute_event',
        proposedBy: { type: 'system' },
      }),
    )
    await d.Effect.runPromise(
      acceptProgram(accepted.id, { type: 'user', id: d.me.id }),
    )
    await d.db.delete(d.schema.entity).where(d.eq(d.schema.entity.id, source))

    const missing = cited.map((r) => ({
      ref: r,
      entityId: null,
      label: d.MISSING_LABEL,
      missing: true,
    }))

    const rows = await d.Effect.runPromise(listInboxProgram())
    const card = rows.find((r) => r.kind === 'suggestion' && r.id === company)
    if (card?.kind !== 'suggestion') throw new Error('no suggestion card')
    expect(card.suggestions.find((s) => s.id === open.id)?.citations).toEqual(
      missing,
    )

    const timeline = await d.Effect.runPromise(recordTimelineProgram(company))
    const burst = timeline.find(
      (i) => i.type === 'attrs' && i.source === 'suggestion',
    )
    if (burst?.type !== 'attrs') throw new Error('no suggestion burst')
    expect(burst.changes).toEqual([
      { slug: 'location', to: 'Berlin', citations: missing },
    ])
  })
})

describe('resolveRefs — cost', () => {
  it('resolves a suggestion carrying twenty refs across five kinds in at most 5 + 1 queries', async () => {
    const d = await deps()
    const refs: Array<string> = []
    for (let i = 0; i < 4; i++) {
      const company = await d.newEntity('company', `Counted ${String(i)}`)
      refs.push(
        d.ref.attr(await d.loserOf('company', company), 'funding_stage'),
        d.ref.note(await d.newNote(`Note ${String(i)}`, 'note')),
        d.ref.memo(await d.newNote(`Memo ${String(i)}`, 'memo')),
        d.ref.doc(await d.newDocument(`deck-${String(i)}.pdf`), i),
        d.ref.term(await d.newTerm(`Term ${String(i)}`)),
      )
    }
    expect(refs).toHaveLength(20)

    const counter = vi.spyOn(d.db.$client, 'query')
    try {
      const resolved = await d.resolve(refs)
      expect(resolved.every((r) => !r.missing)).toBe(true)
      expect(resolved[0].label).toBe('Funding stage on Counted 0')
      expect(counter.mock.calls.length).toBeGreaterThan(0)
      expect(counter.mock.calls.length).toBeLessThanOrEqual(5 + 1)
    } finally {
      counter.mockRestore()
    }
  })
})

describe('cite.ts is the one renderer', () => {
  it('is called only from names.ts, and no other file in src formats a ref', () => {
    const src = join(import.meta.dirname, '..', '..')
    const files: Array<string> = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
          files.push(path)
      }
    }
    walk(src)
    const rel = (f: string) => relative(src, f)

    // Whoever calls `cite(` renders a ref; only the resolver may.
    const callers = files
      .filter((f) => /\bcite\(/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort()
    expect(callers).toEqual(['lib/context/cite.ts', 'lib/context/names.ts'])

    // Nobody else builds a `CiteLookup` or re-derives a label from a parse:
    // the words "· chunk" and the mandate / history fallbacks live in cite.ts.
    const renderers = files
      .filter((f) => {
        const text = readFileSync(f, 'utf8')
        return (
          text.includes('· chunk') ||
          text.includes("'record history'") ||
          /\bCiteLookup\b/.test(text)
        )
      })
      .map(rel)
      .sort()
    expect(renderers).toEqual(['lib/context/cite.ts', 'lib/context/names.ts'])

    // And cite.ts stays pure: the grammar and a type are all it imports.
    const imports = [
      ...readFileSync(join(src, 'lib/context/cite.ts'), 'utf8').matchAll(
        /^import .* from '([^']+)'$/gm,
      ),
    ].map((m) => m[1])
    expect(imports).toEqual(['./ref', './render'])
  })
})
