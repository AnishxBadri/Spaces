import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PROVIDERS, PROVIDER_IDS, redirectUri, unknownScopes } from './registry'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)

/** The part of a manifest this registry answers for. */
const connectionOf = z.looseObject({
  manifest: z.looseObject({
    id: z.string(),
    requires: z
      .looseObject({
        // A keyed connection (a member's pasted key) asks for no scopes.
        connection: z
          .object({
            provider: z.string(),
            scopes: z.array(z.string()).default([]),
          })
          .optional(),
      })
      .optional(),
  }),
})

type Connection = { provider: string; scopes: Array<string> }

/** Every scope a connection asks for that its provider's vocabulary lacks. */
function strays(id: string, connection: Connection | undefined) {
  if (connection === undefined) return []
  return unknownScopes(connection.provider, connection.scopes).map(
    (s) => `${id}: ${connection.provider} ${s}`,
  )
}

/** The shipped plugins — `plugins/*`, never `_fixtures` — by their manifest source. */
const shipped = readdirSync(path.join(ROOT, 'plugins'), {
  withFileTypes: true,
})
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => path.join(ROOT, 'plugins', d.name, 'src', 'manifest.ts'))
  .filter((file) => existsSync(file))

describe('the scope vocabulary', () => {
  it('finds the shipped manifests it checks', () => {
    expect(shipped.length).toBeGreaterThan(0)
  })

  it('lists every scope any shipped manifest requests, under its provider', async () => {
    const found: Array<string> = []
    for (const file of shipped) {
      const mod = connectionOf.parse(
        await import(/* @vite-ignore */ pathToFileURL(file).href),
      )
      found.push(...strays(mod.manifest.id, mod.manifest.requires?.connection))
    }
    expect(found).toEqual([])
  })

  it('names a manifest that asks for a scope its provider does not list', () => {
    // Full `drive` is refused by decision; a typo'd Box scope and an
    // unregistered provider are both strays too.
    expect(
      strays('drive-everything', {
        provider: 'google',
        scopes: ['drive.file', 'drive'],
      }),
    ).toEqual(['drive-everything: google drive'])
    expect(
      strays('box-typo', { provider: 'box', scopes: ['root_read'] }),
    ).toEqual(['box-typo: box root_read'])
    expect(
      strays('dropbox', { provider: 'dropbox', scopes: ['files.read'] }),
    ).toEqual(['dropbox: dropbox files.read'])
  })

  it('records the decided Google scopes and which are restricted', () => {
    const scopes = Object.fromEntries(
      PROVIDERS.google.scopes.map((s) => [s.value, s]),
    )
    expect(scopes['drive.file']).toMatchObject({
      plugin: 'google-drive',
      restricted: false,
      wire: 'https://www.googleapis.com/auth/drive.file',
    })
    expect(scopes['drive.readonly']).toMatchObject({
      plugin: 'google-drive',
      restricted: true,
    })
    expect(scopes['openid'].wire).toBe('openid')
    expect(Object.keys(scopes)).not.toContain('drive')
    expect(Object.keys(scopes)).not.toContain('gmail.modify')
  })
})

describe('PROVIDERS', () => {
  it('carries the four endpoints and a non-empty vocabulary for google and box', () => {
    expect(PROVIDER_IDS).toEqual(['google', 'box'])
    for (const id of PROVIDER_IDS) {
      const entry = PROVIDERS[id]
      for (const url of [
        entry.authUrl,
        entry.tokenUrl,
        entry.revokeUrl,
        entry.userinfoUrl,
      ])
        expect(new URL(url).protocol).toBe('https:')
      expect(entry.scopes.length).toBeGreaterThan(0)
    }
  })
})

describe('redirectUri', () => {
  it('is <APP_URL without trailing slash>/api/connections/<provider>/callback', () => {
    expect(redirectUri('https://deals.example.com', 'google')).toBe(
      'https://deals.example.com/api/connections/google/callback',
    )
    expect(redirectUri('https://deals.example.com/', 'box')).toBe(
      'https://deals.example.com/api/connections/box/callback',
    )
    expect(redirectUri('https://example.com/spaces', 'google')).toBe(
      'https://example.com/spaces/api/connections/google/callback',
    )
  })
})
