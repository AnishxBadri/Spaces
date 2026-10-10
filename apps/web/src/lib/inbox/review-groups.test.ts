import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  space,
  suggestion,
} from '@spaces/db/schema'
import { reviewGroupsProgram } from './review-groups'

/**
 * Today's Review rows read the open queue by source and space: a discovery
 * card's space is its payload's, a record card's is the record's filing.
 * Against this worker's test database, truncated before the file.
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

async function plugin(capabilityId: string, name: string) {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId,
        version: '1.0.0',
        enabled: true,
        status: 'enabled',
        manifest: { name },
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  return row.id
}

const discovery = (spaceId: string, domain: string) => ({
  spaceId,
  domain,
  name: domain,
  evidence: [],
  aliases: [],
  subspaceHint: null,
})

describe('reviewGroupsProgram', () => {
  it('groups open cards by source and space, counting each kind, largest first', async () => {
    const root = await mintSpace(
      'Tday Proptech',
      'tday_proptech',
      'tday_proptech',
      null,
    )
    const ops = await mintSpace(
      'Property ops',
      'property_ops',
      'tday_proptech.property_ops',
      root,
    )
    const exa = await plugin('exa', 'Exa')
    const held = await mint('company', 'Held Co')
    const filed = await mint('company', 'Filed Co')
    await db.insert(entitySpace).values({ entityId: filed, spaceId: ops })

    await db.insert(suggestion).values([
      ...['a.com', 'b.com', 'c.com'].map((domain) => ({
        kind: 'add_record' as const,
        entityId: null,
        payload: discovery(ops, domain),
        proposedByType: 'integration' as const,
        proposedById: exa,
      })),
      {
        kind: 'file_record' as const,
        entityId: held,
        payload: {
          spaceId: ops,
          domain: 'held.com',
          name: 'Held Co',
          evidence: [],
          entityId: held,
        },
        proposedByType: 'integration' as const,
        proposedById: exa,
      },
      // A model's value on a filed record: Judgment, under its filing.
      {
        kind: 'attribute_patch' as const,
        entityId: filed,
        payload: {},
        proposedByType: 'system' as const,
        proposedById: null,
      },
      // The same engine's value on a filed record: its own row, so the
      // space's discovery row counts add and file cards only.
      {
        kind: 'attribute_patch' as const,
        entityId: filed,
        payload: {},
        proposedByType: 'integration' as const,
        proposedById: exa,
      },
      // A model's value on a record filed nowhere.
      {
        kind: 'attribute_patch' as const,
        entityId: held,
        payload: {},
        proposedByType: 'system' as const,
        proposedById: null,
      },
      // A decided card is not on Today.
      {
        kind: 'add_record' as const,
        entityId: null,
        payload: discovery(root, 'gone.com'),
        proposedByType: 'integration' as const,
        proposedById: exa,
        status: 'rejected' as const,
        decidedAt: new Date(),
        decidedBy: (
          await db.execute<{ id: string }>('select id from "user" limit 1')
        ).rows[0].id,
      },
    ])

    const groups = await Effect.runPromise(reviewGroupsProgram())
    expect(
      groups.map((g) => ({
        space: g.spaceLabel,
        source: g.source,
        add: g.toAdd,
        file: g.toFile,
        review: g.toReview,
        total: g.total,
      })),
    ).toEqual([
      {
        space: 'Tday Proptech / Property ops',
        source: 'Exa',
        add: 3,
        file: 1,
        review: 0,
        total: 4,
      },
      {
        space: 'Tday Proptech / Property ops',
        source: 'Exa',
        add: 0,
        file: 0,
        review: 1,
        total: 1,
      },
      {
        space: null,
        source: 'Judgment',
        add: 0,
        file: 0,
        review: 1,
        total: 1,
      },
      {
        space: 'Tday Proptech / Property ops',
        source: 'Judgment',
        add: 0,
        file: 0,
        review: 1,
        total: 1,
      },
    ])
    expect(groups[0].spaceId).toBe(ops)
  })
})
