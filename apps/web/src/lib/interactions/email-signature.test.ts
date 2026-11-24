import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { saveSignatureProgram, signatureProgram } from './email-signature'

/**
 * The signature is its member's alone: each reads and writes only their
 * own row, a blank save clears it, and nothing else on `user` moves.
 */

const ME = { id: FIXTURE_ACTOR.id }
const TEAMMATE = {
  id: 'member-teammate',
  name: 'Priya',
  email: 'priya@fund.example',
  emailVerified: true,
}

const run = <TValue, TError>(program: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(program)

beforeEach(async () => {
  await truncateAndReseed()
  await db.insert(user).values(TEAMMATE)
})

describe('the email signature', () => {
  it('reads empty until written, then as saved, its blank edges trimmed', async () => {
    expect(await run(signatureProgram(ME))).toBe('')
    const stored = await run(
      saveSignatureProgram(ME, '\n  Anish Badri\nPartner, Fund \n\n'),
    )
    expect(stored).toBe('Anish Badri\nPartner, Fund')
    expect(await run(signatureProgram(ME))).toBe('Anish Badri\nPartner, Fund')
  })

  it('is each member’s own', async () => {
    await run(saveSignatureProgram(ME, 'Anish'))
    await run(saveSignatureProgram({ id: TEAMMATE.id }, 'Priya'))
    expect(await run(signatureProgram(ME))).toBe('Anish')
    expect(await run(signatureProgram({ id: TEAMMATE.id }))).toBe('Priya')
  })

  it('clears to null on a blank save, leaving the rest of the row', async () => {
    const before = (await db.select().from(user).where(eq(user.id, ME.id))).at(
      0,
    )
    await run(saveSignatureProgram(ME, 'Anish'))
    await run(saveSignatureProgram(ME, '   \n'))
    const after = (await db.select().from(user).where(eq(user.id, ME.id))).at(0)
    expect(after?.emailSignature).toBeNull()
    expect(after?.email).toBe(before?.email)
    expect(after?.role).toBe(before?.role)
  })
})
