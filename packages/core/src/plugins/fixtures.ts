import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { keyIdOf, writeTar } from '@spaces/sdk/pack'
import type { RegistryEntry, TarInput } from '@spaces/sdk/pack'

/**
 * Test fixtures for the installer: signed plugin tarballs built in memory,
 * with an ephemeral key — no private key is ever committed. Shipping code
 * never imports this.
 */

export type FixtureSigner = {
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
  readonly keyId: string
  /** Writes `<keyId>.pub` into a key directory, which then trusts it. */
  readonly trustIn: (keysDir: string) => void
}

export const fixtureSigner = (): FixtureSigner => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = keyIdOf(publicKey)
  return {
    privateKey,
    publicKey,
    keyId,
    trustIn: (keysDir) =>
      writeFileSync(
        path.join(keysDir, `${keyId}.pub`),
        publicKey.export({ format: 'pem', type: 'spki' }),
      ),
  }
}

export type FixtureInput = {
  readonly id: string
  readonly version: string
  readonly signer: FixtureSigner
  /** The bundle's text; a default export with no jobs when omitted. */
  readonly bundle?: string
  /** Extra files beside manifest.json and bundle.mjs (`migrations/0001.sql`). */
  readonly files?: { readonly [path: string]: string }
  /** Lands on the manifest and on the entry. */
  readonly requires?: RegistryEntry['requires']
  /** Replaces manifest fields. */
  readonly manifest?: { readonly [key: string]: unknown }
  /** Where the entry says the tarball is served. */
  readonly tarballUrl?: string
}

export type FixturePlugin = {
  readonly tarball: Uint8Array
  readonly entry: RegistryEntry
}

const encode = (text: string) => new TextEncoder().encode(text)

/** A signed tarball and its registry entry, as the release workflow would publish them. */
export const fixturePlugin = (input: FixtureInput): FixturePlugin => {
  const manifest = {
    manifestVersion: 1,
    id: input.id,
    version: input.version,
    sdk: '^1.0',
    name: `${input.id.charAt(0).toUpperCase()}${input.id.slice(1)}`,
    description: `The ${input.id} fixture.`,
    settings: { type: 'object', properties: {} },
    jobs: { run: { trigger: 'action', uses: ['Log'] } },
    ...(input.requires === undefined ? {} : { requires: input.requires }),
    ...input.manifest,
  }
  const files: Array<TarInput> = [
    { path: 'manifest.json', data: encode(JSON.stringify(manifest)) },
    {
      path: 'bundle.mjs',
      data: encode(input.bundle ?? 'export default { jobs: {} }\n'),
    },
    ...Object.entries(input.files ?? {}).map(([p, body]) => ({
      path: p,
      data: encode(body),
    })),
  ]
  const tarball = gzipSync(writeTar(files), { level: 9 })
  return {
    tarball,
    entry: {
      id: input.id,
      version: input.version,
      sdk: manifest.sdk,
      name: manifest.name,
      description: manifest.description,
      ...(input.requires === undefined ? {} : { requires: input.requires }),
      tarball:
        input.tarballUrl ??
        `https://example.invalid/plugins/${input.id}-${input.version}.tgz`,
      sha256: createHash('sha256').update(tarball).digest('hex'),
      sig: sign(null, tarball, input.signer.privateKey).toString('base64'),
      keyId: input.signer.keyId,
    },
  }
}
