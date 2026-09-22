import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from './index.ts'
import { entity } from './schema/entities.ts'
import { document } from './schema/kinds.ts'
import { accountConnection } from './schema/vault.ts'
import { user } from './schema/auth.ts'

/**
 * `document_connection_external_unique`, asserted in Postgres (SPA-78,
 * `docs/spec-storage-sources.md` §11 delta 1).
 *
 * The index is the reason the five columns ship together rather than with the
 * first storage-source plugin, so it is worth more than a line in a snapshot.
 * Two claims the TypeScript schema cannot make:
 *
 * 1. One document per (connection, provider file). §6's loop prevention ("our
 *    own export seen by the poll → `external_id` match → no-op") and §8's
 *    cursor-expiry full re-list are both `on conflict` on that pair, and
 *    without the index neither is idempotent — a re-list would double every
 *    row in the bound subtree.
 * 2. It is **partial**. Every document in the workspace today carries both
 *    columns null, and a plain unique index over a nullable pair would still
 *    be honoured for the non-null rows but is trivially satisfied by nulls —
 *    the failure mode worth pinning is the opposite one, an index predicate
 *    typo'd into something that catches the null rows and admits exactly one
 *    hand-uploaded file per workspace.
 *
 * Asserted by constraint *name*, for the reason `source-class.test.ts` gives:
 * drizzle's `Failed query: …` message names the SQL and not the constraint, so
 * matching on the message would pass for a not-null violation or a typo in the
 * fixture.
 */
function constraintOf(err: unknown): string | null {
  let cur: unknown = err
  for (let hop = 0; hop < 5; hop++) {
    if (!(cur instanceof Error)) return null
    const name: unknown = Reflect.get(cur, 'constraint')
    if (typeof name === 'string') return name
    cur = cur.cause
  }
  return null
}

async function refusedBy(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (err) {
    return constraintOf(err)
  }
}

const INDEX = 'document_connection_external_unique'

/** A document entity plus its side-table row, with whatever provenance. */
async function aDocument(values: {
  connectionId?: string
  externalId?: string
  sourcePath?: string
}): Promise<string> {
  const rows = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: `file-${randomUUID()}.pdf` })
    .returning({ id: entity.id })
  const id = rows[0].id
  await db.insert(document).values({ entityId: id, ...values })
  return id
}

describe('document storage-source provenance in Postgres', () => {
  const ids = { connection: '', other: '' }

  beforeAll(async () => {
    const tag = randomUUID().slice(0, 8)
    await db.insert(user).values({
      id: `u-${tag}`,
      name: 'Binder',
      email: `binder-${tag}@fund.example`,
    })
    const made = await db
      .insert(accountConnection)
      .values([
        {
          userId: `u-${tag}`,
          provider: 'google',
          externalEmail: `binder-${tag}@fund.example`,
          tokensEnc: Buffer.from('not a real token'),
        },
        {
          userId: `u-${tag}`,
          provider: 'box',
          externalEmail: `binder-${tag}@fund.example`,
          tokensEnc: Buffer.from('not a real token'),
        },
      ])
      .returning({ id: accountConnection.id })
    ids.connection = made[0].id
    ids.other = made[1].id
  })

  it('refuses a second document for one file on one connection', async () => {
    const externalId = `drive-${randomUUID()}`
    await aDocument({ connectionId: ids.connection, externalId })
    expect(
      await refusedBy(aDocument({ connectionId: ids.connection, externalId })),
    ).toBe(INDEX)
  })

  it('lets the same provider file arrive on two connections', async () => {
    // Two people bind the same shared folder: one blob, two documents (§5.6).
    // The key is the pair, never `external_id` alone.
    const externalId = `drive-${randomUUID()}`
    await aDocument({ connectionId: ids.connection, externalId })
    expect(
      await refusedBy(aDocument({ connectionId: ids.other, externalId })),
    ).toBeNull()
  })

  it('leaves every hand-uploaded document alone', async () => {
    // The partial predicate, which is the whole point: three rows with both
    // columns null are three rows, not one row and two unique violations.
    for (let i = 0; i < 3; i++)
      expect(await refusedBy(aDocument({}))).toBeNull()
    // Half a pair is not a pair either — a path with no external id is a
    // document nothing can collide with.
    expect(
      await refusedBy(aDocument({ sourcePath: 'Data room / Legal' })),
    ).toBe(null)
    expect(
      await refusedBy(aDocument({ connectionId: ids.connection })),
    ).toBeNull()
    expect(
      await refusedBy(aDocument({ connectionId: ids.connection })),
    ).toBeNull()
  })
})
