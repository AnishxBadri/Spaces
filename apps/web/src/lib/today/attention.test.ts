import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { db } from '@spaces/db'
import {
  duplicateCandidate,
  entity,
  entitySpace,
  integration,
  space,
  suggestion,
  user,
} from '@spaces/db/schema'
import { todayAttentionProgram } from './attention'
import { flattenInbox } from './proposals'

/**
 * Today reads the open Review queue whole — pairs included — and, for a
 * file-here card, where its record is filed now. Against this worker's test
 * database, truncated before the file.
 */

async function mint(kind: 'company' | 'space', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no entity')
  return row.id
}

async function mintSpace(
  name: string,
  slug: string,
  path: string,
  parentId: string | null,
) {
  const id = await mint('space', name)
  await db.insert(space).values({ entityId: id, slug, path, parentId })
  return id
}

describe('todayAttentionProgram', () => {
  it('carries the queue with its pairs, and where a file-here record is filed', async () => {
    const reader = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!reader) throw new Error('no fixture user')
    const proptech = await mintSpace('Proptech', 'proptech', 'proptech', null)
    const rental = await mintSpace(
      'Rental software',
      'rental',
      'proptech.rental',
      proptech,
    )
    const ops = await mintSpace('Property ops', 'ops', 'proptech.ops', proptech)
    const held = await mint('company', 'Rentwise')
    await db.insert(entitySpace).values({ entityId: held, spaceId: rental })
    const [a, b] = [
      await mint('company', 'Acme'),
      await mint('company', 'Acme Inc'),
    ].sort()
    const pair = (
      await db
        .insert(duplicateCandidate)
        .values({
          entityA: a,
          entityB: b,
          score: 0.9,
          reason: { shared: 'domain' },
        })
        .returning({ id: duplicateCandidate.id })
    ).at(0)
    if (!pair) throw new Error('no pair')
    const exa = (
      await db
        .insert(integration)
        .values({
          capabilityId: 'exa',
          version: '1.0.0',
          enabled: true,
          status: 'enabled',
          manifest: { name: 'Exa' },
        })
        .returning({ id: integration.id })
    ).at(0)
    if (!exa) throw new Error('no integration')
    await db.insert(suggestion).values({
      kind: 'file_record',
      entityId: held,
      payload: {
        spaceId: ops,
        domain: 'rentwise.com',
        name: 'Rentwise',
        evidence: [],
        entityId: held,
      },
      proposedByType: 'integration',
      proposedById: exa.id,
    })

    const out = await Effect.runPromise(
      todayAttentionProgram(reader.id, new Date()),
    )
    expect(out.review.map((r) => r.kind).sort()).toEqual([
      'discovery',
      'duplicate_candidate',
    ])
    expect(out.filedIn).toEqual({ [held]: 'Proptech / Rental software' })

    const rows = flattenInbox(out.review, {
      today: '2026-10-28',
      filedIn: out.filedIn,
    })
    const leaf = rows.find((r) => r.key === `pair:${pair.id}`)
    expect(leaf?.line).toBe('Possibly the same · domain on both')
    const group = rows.find((r) => r.kind === 'group')
    expect(group?.kind === 'group' ? group.children.at(0)?.line : null).toBe(
      'Filed in Proptech / Rental software',
    )
  })
})
