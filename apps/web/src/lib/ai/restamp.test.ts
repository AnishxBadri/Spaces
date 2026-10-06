import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { chunk, entity } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { birthDocumentProgram } from '@spaces/core/writes/documents/birth'
import { stampSensitivity } from '@spaces/core/writes/ai/stamp-sensitivity'
import { enqueued } from '#/test/queue-stub'
import { webEnqueue } from '#/lib/enqueue-live'
import {
  fileDocumentProgram,
  unfileDocumentProgram,
} from '#/lib/documents/refile'
import { createSpaceRow } from '#/lib/server/shared'
import { insertSpaceTag } from '#/lib/spaces/tag'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { setEntitySensitiveProgram } from './sensitivity-for'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * `chunk.sensitive` follows every input change: raising is synchronous, in
 * the transaction of the flag or the filing; lowering is a
 * `sensitivity.restamp` job per entity, which resolves live.
 */

let n = 0
const tag = () => `${String(++n)}_${Math.random().toString(36).slice(2, 6)}`

async function anEmbeddedDoc(name: string): Promise<string> {
  const { id } = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: null,
      filename: `${name}.html`,
      url: `https://example.com/${name}`,
      mime: 'text/html',
      sizeBytes: null,
      kind: 'other',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: [],
      actor: { userId: FIXTURE_ACTOR.id },
    }).pipe(Effect.provide(webEnqueue)),
  )
  // What the embed job leaves behind: chunks stamped by the resolver, which
  // for an unfiled, unflagged document is `false`.
  await addChunks(id, name)
  return id
}

async function addChunks(entityId: string, name: string): Promise<void> {
  await db.insert(chunk).values(
    [0, 1, 2].map((idx): typeof chunk.$inferInsert => ({
      entityId,
      sourceKind: 'document',
      sourceKey: '',
      idx,
      text: `${name} page ${String(idx)}`,
    })),
  )
}

async function aCompanyWithChunk(name: string): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  await db.insert(chunk).values({
    entityId: row.id,
    sourceKind: 'attribute',
    sourceKey: 'description',
    idx: 0,
    text: `${name} makes electrolysers`,
  })
  return row.id
}

const aSpace = (name: string, parentId: string | null = null) =>
  createSpaceRow(`${name} ${tag()}`, parentId, FIXTURE_ACTOR.id)

async function stamps(entityId: string): Promise<Array<boolean>> {
  const rows = await db
    .select({ sensitive: chunk.sensitive })
    .from(chunk)
    .where(eq(chunk.entityId, entityId))
  expect(rows.length).toBeGreaterThan(0)
  return [...new Set(rows.map((r) => r.sensitive))]
}

const flag = (entityId: string, sensitive = true) =>
  Effect.runPromise(setEntitySensitiveProgram(entityId, sensitive))

const fileIn = (documentId: string, spaceId: string) =>
  Effect.runPromise(
    fileDocumentProgram(FIXTURE_ACTOR.id, {
      documentId,
      target: { kind: 'space', entityId: spaceId },
    }),
  )

const unfileFrom = (documentId: string, spaceId: string) =>
  Effect.runPromise(
    unfileDocumentProgram(FIXTURE_ACTOR.id, {
      documentId,
      target: { kind: 'space', entityId: spaceId },
    }),
  )

/** The restamp jobs sent, by entity — what the worker would run. */
const restampsSent = () =>
  enqueued
    .filter((e) => e.name === QUEUES.restampSensitivity)
    .map((e) => e.data.entityId)

/** Run every queued restamp, as the worker would, and forget them. */
async function runRestamps(): Promise<void> {
  for (const id of restampsSent())
    if (typeof id === 'string') await Effect.runPromise(stampSensitivity(id))
  enqueued.length = 0
}

beforeEach(() => {
  enqueued.length = 0
})

describe('raising is synchronous', () => {
  it('flagging an embedded document stamps every one of its chunks before the call returns', async () => {
    const doc = await anEmbeddedDoc('memo')
    expect(await stamps(doc)).toEqual([false])
    await flag(doc)
    expect(await stamps(doc)).toEqual([true])
    expect(restampsSent()).toEqual([])
  })

  it('flagging a space stamps everything filed in it and its descendants, and nothing beside it', async () => {
    const root = await aSpace('Hydrogen')
    const child = await aSpace('Electrolysers', root)
    const grandchild = await aSpace('Stacks', child)
    const sibling = await aSpace('Aerospace')

    const inRoot = await anEmbeddedDoc('root-deck')
    const inGrandchild = await anEmbeddedDoc('grandchild-deck')
    const outside = await anEmbeddedDoc('aero-deck')
    const company = await aCompanyWithChunk(`Electra ${tag()}`)
    await fileIn(inRoot, root)
    await fileIn(inGrandchild, grandchild)
    await fileIn(outside, sibling)
    await db.transaction((tx) =>
      insertSpaceTag(tx, {
        entityId: company,
        spaceId: child,
        source: 'manual',
        confidence: null,
        createdBy: FIXTURE_ACTOR.id,
      }),
    )
    for (const id of [inRoot, inGrandchild, outside, company])
      expect(await stamps(id)).toEqual([false])

    await flag(root)

    for (const id of [inRoot, inGrandchild, company])
      expect(await stamps(id)).toEqual([true])
    expect(await stamps(outside)).toEqual([false])
    // Inheritance still writes no entity row.
    const own = await db
      .select({ sensitive: entity.sensitive })
      .from(entity)
      .where(eq(entity.id, inGrandchild))
    expect(own).toEqual([{ sensitive: false }])
  })

  it('filing an embedded document into a sensitive space — or under one — stamps its chunks in the filing', async () => {
    const root = await aSpace('Hydrogen')
    const child = await aSpace('Electrolysers', root)
    await flag(root)
    const doc = await anEmbeddedDoc('deck')
    await fileIn(doc, child)
    expect(await stamps(doc)).toEqual([true])
  })

  it('a tag into a sensitive space stamps the record', async () => {
    const space = await aSpace('Hydrogen')
    await flag(space)
    const company = await aCompanyWithChunk(`Electra ${tag()}`)
    await db.transaction((tx) =>
      insertSpaceTag(tx, {
        entityId: company,
        spaceId: space,
        source: 'manual',
        confidence: null,
        createdBy: FIXTURE_ACTOR.id,
      }),
    )
    expect(await stamps(company)).toEqual([true])
  })

  it('filing into a space nobody flagged leaves the chunks alone', async () => {
    const space = await aSpace('Aerospace')
    const doc = await anEmbeddedDoc('deck')
    await fileIn(doc, space)
    expect(await stamps(doc)).toEqual([false])
  })

  it('a deduped birth that adds a sensitive space stamps the existing row', async () => {
    const plain = await aSpace('Aerospace')
    const sensitive = await aSpace('Hydrogen')
    await flag(sensitive)
    const sha = `sha-${tag()}`.padEnd(64, '0')
    const born = (fileAgainst: Array<string>) =>
      Effect.runPromise(
        birthDocumentProgram({
          blobSha: sha,
          filename: 'deck.pdf',
          mime: 'application/pdf',
          sizeBytes: 1024,
          kind: 'deck',
          sourceClass: 'manual',
          sourceRef: null,
          provenance: {},
          fileAgainst: fileAgainst.map((entityId) => ({
            kind: 'space',
            entityId,
          })),
          actor: { userId: FIXTURE_ACTOR.id },
        }).pipe(Effect.provide(webEnqueue)),
      )
    const first = await born([plain])
    await addChunks(first.id, 'deck')
    const again = await born([plain, sensitive])
    expect(again).toEqual({ id: first.id, deduped: true })
    expect(await stamps(first.id)).toEqual([true])
  })
})

describe('lowering is a job', () => {
  it('clearing a record flag enqueues its restamp, and the job lowers it', async () => {
    const doc = await anEmbeddedDoc('memo')
    await flag(doc)
    await flag(doc, false)
    expect(await stamps(doc)).toEqual([true])
    expect(restampsSent()).toEqual([doc])
    const job = enqueued.find((e) => e.name === QUEUES.restampSensitivity)
    expect(job?.options).toEqual({ singletonKey: doc })
    await runRestamps()
    expect(await stamps(doc)).toEqual([false])
  })

  it('clearing a space flag enqueues one restamp per entity still stamped beneath it', async () => {
    const root = await aSpace('Hydrogen')
    const child = await aSpace('Electrolysers', root)
    const a = await anEmbeddedDoc('a')
    const b = await anEmbeddedDoc('b')
    await fileIn(a, root)
    await fileIn(b, child)
    await flag(root)
    await flag(root, false)
    expect(restampsSent().sort()).toEqual([a, b].sort())
    await runRestamps()
    expect(await stamps(a)).toEqual([false])
    expect(await stamps(b)).toEqual([false])
  })

  it('unfiling from one of two sensitive spaces keeps the document sensitive; unfiling from the second lowers it', async () => {
    const first = await aSpace('Hydrogen')
    const second = await aSpace('Defence')
    await flag(first)
    await flag(second)
    const doc = await anEmbeddedDoc('deck')
    await fileIn(doc, first)
    await fileIn(doc, second)
    expect(await stamps(doc)).toEqual([true])

    expect(await unfileFrom(doc, first)).toEqual({ unfiled: true })
    expect(restampsSent()).toEqual([doc])
    await runRestamps()
    expect(await stamps(doc)).toEqual([true])

    expect(await unfileFrom(doc, second)).toEqual({ unfiled: true })
    expect(restampsSent()).toEqual([doc])
    await runRestamps()
    expect(await stamps(doc)).toEqual([false])
  })

  it('a record flagged on its own stays stamped when it leaves a sensitive space', async () => {
    const space = await aSpace('Hydrogen')
    await flag(space)
    const doc = await anEmbeddedDoc('deck')
    await fileIn(doc, space)
    await flag(doc)
    await unfileFrom(doc, space)
    await runRestamps()
    expect(await stamps(doc)).toEqual([true])
  })

  it('nothing stamped, nothing enqueued', async () => {
    const space = await aSpace('Aerospace')
    const doc = await anEmbeddedDoc('deck')
    await fileIn(doc, space)
    await unfileFrom(doc, space)
    await flag(space)
    enqueued.length = 0
    await flag(space, false)
    expect(restampsSent()).toEqual([])
  })
})
