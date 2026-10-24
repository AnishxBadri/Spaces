import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { entity, importBatch, importRow, objectDef } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { beginImportMappingProgram } from './mapping'
import { planImportProgram } from './plan'
import { commitImportProgram } from './commit'

/**
 * Importing people onto the name parts, end to end: First name and
 * Last name columns land on the parts and make `canonical_name`; a Name
 * column lands on the join and is split into the parts.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const ME = FIXTURE_ACTOR.id

async function peopleObject(): Promise<string> {
  const row = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, 'people'))
  ).at(0)
  if (!row) throw new Error('people object missing')
  return row.id
}

async function importPeople(header: Array<string>, rows: Array<Array<string>>) {
  const batch = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'd'.repeat(64),
        filename: 'people.csv',
        sizeBytes: 100,
        sheet: 'sheet',
        sheets: ['sheet'],
        headerRow: 0,
        header,
        mode: 'records',
        targetObjectId: await peopleObject(),
        rowCount: rows.length,
        createdBy: ME,
      })
      .returning({ id: importBatch.id })
  ).at(0)
  if (!batch) throw new Error('batch insert returned no row')
  await db
    .insert(importRow)
    .values(
      rows.map((cells, i) => ({ batchId: batch.id, rowNum: i + 1, cells })),
    )
  await Effect.runPromise(beginImportMappingProgram(batch.id))
  await Effect.runPromise(planImportProgram(batch.id))
  await Effect.runPromise(
    commitImportProgram({ batchId: batch.id, userId: ME, onlyFailed: false }),
  )
}

async function personByEmail(email: string) {
  const rows = await db
    .select({ name: entity.canonicalName, values: entity.values })
    .from(entity)
    .where(eq(entity.kind, 'person'))
  const hit = rows.find(
    (r) => Array.isArray(r.values.emails) && r.values.emails.includes(email),
  )
  if (!hit) throw new Error(`no person holding ${email}`)
  return hit
}

describe('import onto the name parts', () => {
  it('First name and Last name columns make the name', async () => {
    await importPeople(
      ['First name', 'Last name', 'Email'],
      [['Dana', 'Moreau-Iyer', 'dana@flent.example']],
    )
    const dana = await personByEmail('dana@flent.example')
    expect(dana.name).toBe('Dana Moreau-Iyer')
    expect(dana.values).toMatchObject({
      first_name: 'Dana',
      last_name: 'Moreau-Iyer',
    })
  })

  it('a Name column is the join, split into the parts', async () => {
    await importPeople(
      ['Name', 'Email'],
      [['Jean Claude Van Damme', 'jcvd@films.example']],
    )
    const jean = await personByEmail('jcvd@films.example')
    expect(jean.name).toBe('Jean Claude Van Damme')
    expect(jean.values).toMatchObject({
      first_name: 'Jean Claude Van',
      last_name: 'Damme',
    })
  })
})
