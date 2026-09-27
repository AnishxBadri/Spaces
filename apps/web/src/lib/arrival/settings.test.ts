import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { credential, integration, mailbox } from '@spaces/db/schema'
import { FakeImapServer } from '#/test/fake-imap'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { MAILBOX } from './fixtures'
import {
  MAILBOX_CAPABILITY,
  readMailboxSettingsProgram,
  saveMailboxProgram,
  testMailboxProgram,
} from './settings'

/**
 * SPA-56: Settings → Arrival's programs. The app password is write-only —
 * stored through `storeCredential` as `kind: 'mailbox'`, read back only as
 * its redacted display — and Test connection answers in the server's words.
 * The tests share one file's database and run in order.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const SECRET = 'abcd-efgh-ijkl-mnop'
let server: FakeImapServer
let port = 0

beforeAll(async () => {
  server = new FakeImapServer({ user: MAILBOX, password: SECRET })
  server.deliver('Message-ID: <x@y>\nSubject: hi\n\nhello\n')
  port = await server.start()
})

afterAll(async () => {
  await server.stop()
})

const fields = () => ({
  address: MAILBOX,
  host: '127.0.0.1',
  port,
  useTls: false,
  folder: 'INBOX',
  cadenceMinutes: 10,
})

describe('Settings → Arrival', () => {
  it('reads as not configured before the first save', async () => {
    const view = await Effect.runPromise(readMailboxSettingsProgram())
    expect(view).toEqual({ mailbox: null, lastRun: null })
  })

  it('refuses a first save with no app password', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(saveMailboxProgram(FIXTURE_ACTOR.id, fields())),
    )
    expect(failure.message).toBe('An app password is required')
    expect(await db.select().from(mailbox)).toEqual([])
  })

  it('stores the password as a mailbox credential and shows only its redaction', async () => {
    await Effect.runPromise(
      saveMailboxProgram(FIXTURE_ACTOR.id, { ...fields(), password: SECRET }),
    )
    const row = (
      await db
        .select()
        .from(credential)
        .where(eq(credential.provider, 'mailbox'))
    ).at(0)
    expect(row?.kind).toBe('mailbox')
    expect(row?.secretEnc.toString('utf8')).not.toContain(SECRET)

    const integ = (
      await db
        .select()
        .from(integration)
        .where(eq(integration.capabilityId, MAILBOX_CAPABILITY))
    ).at(0)
    expect(integ).toMatchObject({ enabled: true, credentialId: row?.id })

    const view = await Effect.runPromise(readMailboxSettingsProgram())
    expect(view.mailbox).toMatchObject({
      address: MAILBOX,
      cadenceMinutes: 10,
      status: 'pending',
      passwordDisplay: 'abc…mnop',
    })
    expect(JSON.stringify(view)).not.toContain(SECRET)
  })

  it('keeps the stored password when a later save leaves it blank', async () => {
    await Effect.runPromise(
      saveMailboxProgram(FIXTURE_ACTOR.id, { ...fields(), cadenceMinutes: 20 }),
    )
    const boxes = await db.select().from(mailbox)
    expect(boxes).toHaveLength(1)
    expect(boxes.at(0)?.cadenceMinutes).toBe(20)
    // Test connection with no password typed uses the stored one.
    const ok = await Effect.runPromise(testMailboxProgram(fields()))
    expect(ok).toEqual({ ok: true, exists: 1, uidValidity: 1 })
  })

  it('answers a refused login in the server’s words', async () => {
    const result = await Effect.runPromise(
      testMailboxProgram({ ...fields(), password: 'wrong' }),
    )
    expect(result).toEqual({
      ok: false,
      message:
        'Login refused: [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
    })
  })

  it('answers an unreachable host without throwing', async () => {
    const result = await Effect.runPromise(
      testMailboxProgram({ ...fields(), port: 1, password: 'x' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.message).toMatch(/^Could not reach the mailbox: /)
  })
})
