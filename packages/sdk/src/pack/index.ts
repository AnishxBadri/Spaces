import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { z } from 'zod'
import { manifestSchema } from '../manifest.ts'
import type { Manifest } from '../manifest.ts'
import { writeTar } from './tar.ts'
import type { TarInput } from './tar.ts'

export { readTar, writeTar, TarFormatError } from './tar.ts'
export type { TarEntry, TarEntryType, TarInput } from './tar.ts'

/**
 * Pack and sign a plugin (sdk-21a; D54, docs/spec-plugin-sdk.md §9). Node
 * only — `@spaces/sdk/pack` is a separate subpath so the contract a plugin
 * imports never reaches `node:*`. Authors run it; the plugin release
 * workflow (ship-9) runs it with the signing key from its secret. Core's
 * `plugins/verify.ts` is the other half and reads what this writes.
 *
 * The artifact set for `<id>-<version>`:
 *
 *   <id>-<version>.tgz          gzip(ustar) of manifest.json, bundle.mjs and
 *                               migrations/** — the files the loader finds in
 *                               /data/plugins/<id>/<version>/
 *   <id>-<version>.tgz.sha256   `<hex>  <file>`, sha256sum's format
 *   <id>-<version>.tgz.sig      the detached raw ed25519 signature over the
 *                               .tgz bytes, base64 — absent when unsigned
 *   <id>-<version>.json         the registry entry for it
 */

/**
 * A key id names a public key by its content: `ed25519-` and the first 16
 * hex digits of sha256 over the raw 32-byte key. A trusted key's file is
 * `plugin-keys/<keyId>.pub`, and the verifier refuses a file whose key does
 * not hash to its name — a mislabelled key is not trusted under a borrowed id.
 */
export const keyIdOf = (key: KeyObject): string => {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `plugin keys are ed25519, not ${publicKey.asymmetricKeyType ?? 'unknown'}`,
    )
  }
  // The DER SPKI of an ed25519 key is a fixed 12-byte prefix + the 32 raw bytes.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return `ed25519-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

const KEY_ID = /^ed25519-[0-9a-f]{16}$/
const SHA256 = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * One `registry.json` entry (§9, as sdk-21a fixes it). No `kind` (D51).
 * `keyId` names the public key the image trusts for `sig`; the key itself is
 * never in the registry — whoever serves the registry would then choose it.
 */
export const registryEntrySchema = z.strictObject({
  id: manifestSchema.shape.id,
  version: manifestSchema.shape.version,
  sdk: manifestSchema.shape.sdk,
  name: z.string().min(1),
  description: z.string().min(1),
  requires: manifestSchema.shape.requires,
  tarball: z.url(),
  sha256: z.string().regex(SHA256),
  sig: z.string().regex(BASE64),
  keyId: z.string().regex(KEY_ID),
  minCore: z.string().optional(),
})
export type RegistryEntry = z.output<typeof registryEntrySchema>

/** `registry.json`: every published plugin version, newest last per id. */
export const registrySchema = z.array(registryEntrySchema)

/** The files a plugin tarball carries, relative to the built `dist/`. */
const collect = async (distDir: string): Promise<Array<TarInput>> => {
  const files: Array<TarInput> = []
  for (const name of ['manifest.json', 'bundle.mjs']) {
    const file = path.join(distDir, name)
    if (!existsSync(file)) {
      throw new Error(`${file} is missing — build the plugin first`)
    }
    files.push({ path: name, data: await readFile(file) })
  }
  const migrations = path.join(distDir, 'migrations')
  if (existsSync(migrations)) {
    for (const rel of (await readdir(migrations, { recursive: true })).sort()) {
      const file = path.join(migrations, rel)
      const data = await readFile(file).catch(() => null) // a directory
      if (data)
        files.push({
          path: `migrations/${rel.split(path.sep).join('/')}`,
          data,
        })
    }
  }
  return files
}

export type PackOptions = {
  /** The plugin's build output: manifest.json, bundle.mjs, migrations/. */
  readonly distDir: string
  /** Where the artifacts land. */
  readonly outDir: string
  /** Where the tarball will be served from; recorded in the entry. */
  readonly tarballBaseUrl?: string
  /** The ed25519 private key (PEM or KeyObject). Omitted → unsigned. */
  readonly privateKey?: KeyObject | string
}

export type PackResult = {
  readonly manifest: Manifest
  readonly tarball: string
  readonly sha256: string
  /** base64; null when packed unsigned. */
  readonly sig: string | null
  readonly keyId: string | null
  /** The registry entry, when signed (an unsigned pack has none). */
  readonly entry: RegistryEntry | null
}

export const packPlugin = async (options: PackOptions): Promise<PackResult> => {
  const files = await collect(options.distDir)
  const manifestFile = files.find((f) => f.path === 'manifest.json')
  const manifest = manifestSchema.parse(
    JSON.parse(new TextDecoder().decode(manifestFile?.data)),
  )
  const base = `${manifest.id}-${manifest.version}.tgz`
  // gzip's header carries no timestamp from node, so the bytes are a pure
  // function of the files.
  const tgz = gzipSync(writeTar(files), { level: 9 })
  const sha256 = createHash('sha256').update(tgz).digest('hex')

  await mkdir(options.outDir, { recursive: true })
  const tarball = path.join(options.outDir, base)
  await writeFile(tarball, tgz)
  await writeFile(`${tarball}.sha256`, `${sha256}  ${base}\n`)

  if (options.privateKey === undefined) {
    return { manifest, tarball, sha256, sig: null, keyId: null, entry: null }
  }
  const key =
    typeof options.privateKey === 'string'
      ? createPrivateKey(options.privateKey)
      : options.privateKey
  const sig = signBytes(null, tgz, key).toString('base64')
  const keyId = keyIdOf(key)
  await writeFile(`${tarball}.sig`, `${sig}\n`)

  const entry = registryEntrySchema.parse({
    id: manifest.id,
    version: manifest.version,
    sdk: manifest.sdk,
    name: manifest.name,
    description: manifest.description,
    ...(manifest.requires ? { requires: manifest.requires } : {}),
    tarball: `${(options.tarballBaseUrl ?? 'https://example.invalid/plugins').replace(/\/$/, '')}/${base}`,
    sha256,
    sig,
    keyId,
  })
  await writeFile(
    path.join(options.outDir, `${manifest.id}-${manifest.version}.json`),
    `${JSON.stringify(entry, null, 2)}\n`,
  )
  return { manifest, tarball, sha256, sig, keyId, entry }
}
