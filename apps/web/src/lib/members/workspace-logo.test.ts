import { randomBytes } from 'node:crypto'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The workspace logo's write path against the real store: the bytes, the
 * digest at `workspace.settings.logo`, and blob GC counting it.
 *
 * Dynamic imports: `@spaces/db` builds its pool from `DATABASE_URL` at import
 * time and `vitest.setup.ts` rewrites it per file.
 */

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** A PNG no earlier run stored: the local store outlives the database. */
const aPng = () => {
  const bytes = new Uint8Array(64)
  bytes.set(randomBytes(64))
  bytes.set(PNG)
  return bytes
}

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

async function settings() {
  const { db } = await import('@spaces/db')
  const { workspace } = await import('@spaces/db/schema')
  const [row] = await db
    .select({ settings: workspace.settings })
    .from(workspace)
  return row.settings
}

async function pending(sha: string) {
  const { db } = await import('@spaces/db')
  const { pendingBlob } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  return db.select().from(pendingBlob).where(eq(pendingBlob.sha, sha))
}

beforeEach(async () => {
  const { db } = await import('@spaces/db')
  const { workspace } = await import('@spaces/db/schema')
  await db
    .insert(workspace)
    .values({
      id: 1,
      name: 'Northwind Capital',
      settings: { base_currency: 'USD' },
    })
    .onConflictDoUpdate({
      target: workspace.id,
      set: { settings: { base_currency: 'USD' } },
    })
})

describe('the workspace logo', () => {
  it('stores the bytes and the digest, and blob GC counts it', async () => {
    const { setLogoProgram } = await import('./workspace-logo')
    const { blobIsReferenced, reclaimBlobIfOrphaned } =
      await import('#/lib/documents/blob-refs')
    const { storage } = await import('@spaces/core/writes/storage')

    const { sha, previous } = await Effect.runPromise(
      setLogoProgram({ bytes: aPng(), by: await actorId() }),
    )
    expect(previous).toBeNull()
    expect(await settings()).toEqual({ base_currency: 'USD', logo: sha })
    expect(await storage().exists(sha)).toBe(true)
    // Named by the settings now, so the orphan sweep never sees it.
    expect(await pending(sha)).toEqual([])
    expect(await blobIsReferenced(sha)).toBe(true)
    expect(await reclaimBlobIfOrphaned(sha)).toBe(false)
    expect(await storage().exists(sha)).toBe(true)
  })

  it('answers the digest it replaced, and Remove clears it', async () => {
    const { clearLogoProgram, setLogoProgram } =
      await import('./workspace-logo')
    const { reclaimBlobIfOrphaned } = await import('#/lib/documents/blob-refs')
    const { storage } = await import('@spaces/core/writes/storage')
    const by = await actorId()

    const first = await Effect.runPromise(setLogoProgram({ bytes: aPng(), by }))
    const second = await Effect.runPromise(
      setLogoProgram({ bytes: aPng(), by }),
    )
    expect(second.previous).toBe(first.sha)
    expect(await reclaimBlobIfOrphaned(first.sha)).toBe(true)
    expect(await storage().exists(first.sha)).toBe(false)

    const cleared = await Effect.runPromise(clearLogoProgram())
    expect(cleared.previous).toBe(second.sha)
    expect(await settings()).toEqual({ base_currency: 'USD' })
    expect(await reclaimBlobIfOrphaned(second.sha)).toBe(true)
    expect(await storage().exists(second.sha)).toBe(false)
  })

  it('refuses a 3 MB file and a PDF with the reason, storing nothing', async () => {
    const { setLogoProgram } = await import('./workspace-logo')
    const by = await actorId()
    const big = new Uint8Array(3 * 1024 * 1024)
    big.set(PNG)
    const pdf = new TextEncoder().encode('%PDF-1.7\n')

    for (const [bytes, message] of [
      [big, 'The logo is larger than 1 MB'],
      [pdf, 'The logo must be a PNG, JPEG, GIF, WebP or SVG image'],
    ] as const) {
      const failure = await Effect.runPromise(
        Effect.flip(setLogoProgram({ bytes, by })),
      )
      expect(failure).toMatchObject({ _tag: 'LogoRefused', message })
    }
    expect(await settings()).toEqual({ base_currency: 'USD' })
  })

  it('serves only the current logo, with its type', async () => {
    const { readLogo, setLogoProgram } = await import('./workspace-logo')
    const svg = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg"><title>${randomBytes(8).toString('hex')}</title></svg>`,
    )
    const { sha } = await Effect.runPromise(
      setLogoProgram({ bytes: svg, by: await actorId() }),
    )
    expect((await readLogo(sha))?.type).toBe('image/svg+xml')
    expect(await readLogo('0'.repeat(64))).toBeNull()
  })
})
