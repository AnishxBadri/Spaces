import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { company, document, entity, link } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { alreadyHereProgram } from './already-here'

/**
 * The duplicate check a file added on the Files page asks before anything
 * is stored, against the test database: found by its bytes, not its name,
 * and never through a file the reader may not read.
 */

const ME = { id: FIXTURE_ACTOR.id }
const TEAMMATE = {
  id: 'member-teammate-already-here',
  name: 'Priya',
  email: 'priya-already-here@fund.example',
  emailVerified: true,
}

beforeAll(async () => {
  await db.insert(user).values(TEAMMATE).onConflictDoNothing()
})

const shaOf = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex')

/** A document on `sha`, filed on `under` when given, private when told. */
async function aFile(input: {
  filename: string
  sha: string
  under?: string
  privateTo?: string
}): Promise<string> {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: input.filename })
      .returning({ id: entity.id })
  ).at(0)
  if (ent === undefined) throw new Error('no document')
  await db.insert(document).values({
    entityId: ent.id,
    filename: input.filename,
    kind: 'other',
    blobSha: input.sha,
    ...(input.privateTo === undefined
      ? {}
      : { visibility: 'private' as const, authorId: input.privateTo }),
  })
  if (input.under !== undefined)
    await db.insert(link).values({
      fromEntityId: ent.id,
      toEntityId: input.under,
      relation: 'tagged_in',
    })
  return ent.id
}

async function aCompany(name: string): Promise<string> {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (ent === undefined) throw new Error('no company')
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

const run = (sha: string) => Effect.runPromise(alreadyHereProgram(ME, sha))

describe('alreadyHereProgram', () => {
  it('finds a file by its bytes, under any name, and names where it is filed', async () => {
    const exponent = await aCompany('Exponent')
    const sha = shaOf('cap table, October')
    const id = await aFile({
      filename: 'Cap table — Oct.xlsx',
      sha,
      under: exponent,
    })
    // A different file that only shares the name is no match.
    await aFile({ filename: 'Cap table — Oct (1).xlsx', sha: shaOf('other') })

    await expect(run(sha)).resolves.toEqual({
      id,
      filename: 'Cap table — Oct.xlsx',
      under: 'Exponent',
    })
    await expect(run(shaOf('never stored'))).resolves.toBeNull()
  })

  it('never answers through a file the reader may not read', async () => {
    const sha = shaOf('a teammate’s private memo')
    await aFile({ filename: 'Memo.pdf', sha, privateTo: TEAMMATE.id })
    await expect(run(sha)).resolves.toBeNull()

    // The reader's own copy of the same bytes is found, unfiled.
    const mine = await aFile({ filename: 'Memo copy.pdf', sha })
    await expect(run(sha)).resolves.toEqual({
      id: mine,
      filename: 'Memo copy.pdf',
      under: null,
    })
  })
})
