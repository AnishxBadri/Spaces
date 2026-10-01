import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { Effect, Exit } from 'effect'
import { keyIdOf, packPlugin } from '@spaces/sdk/pack'
import { beforeAll, describe, expect, it } from 'vitest'
import { allowUnsignedMarker, loadPluginTrust } from './trust.ts'
import { UNSIGNED_ALLOWED, verifyPlugin } from './verify.ts'
import type { EntryToVerify, PluginTrust, RefusalCode } from './verify.ts'

/**
 * sdk-21a's tamper checks, end to end: a plugin packed and signed by the
 * SDK's packer (with an ephemeral key — no private key is ever committed),
 * then verified here against the trust `loadPluginTrust` reads from disk.
 * No database.
 */

const manifest = {
  manifestVersion: 1,
  id: 'fixture',
  version: '1.0.0',
  sdk: '^1.0',
  name: 'Fixture',
  description: 'A plugin for the verifier tests.',
  settings: { type: 'object', properties: {} },
  jobs: { run: { trigger: 'action', uses: ['Log'] } },
}

const tmp = (label: string) => mkdtempSync(join(tmpdir(), `spaces-${label}-`))

const keypair = () => generateKeyPairSync('ed25519')

let root: string
let keysDir: string
let dataDir: string
let signer: { privateKey: KeyObject; publicKey: KeyObject }
let tarball: Uint8Array
let entry: EntryToVerify
let trust: PluginTrust

const writeKey = (dir: string, publicKey: KeyObject, name?: string) =>
  writeFileSync(
    join(dir, `${name ?? keyIdOf(publicKey)}.pub`),
    publicKey.export({ format: 'pem', type: 'spki' }),
  )

beforeAll(async () => {
  root = tmp('verify')
  const dist = join(root, 'dist')
  mkdirSync(dist)
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(dist, 'bundle.mjs'), 'export default {}\n')
  keysDir = join(root, 'plugin-keys')
  mkdirSync(keysDir)
  dataDir = join(root, 'data')
  mkdirSync(join(dataDir, 'plugins'), { recursive: true })
  signer = keypair()
  writeKey(keysDir, signer.publicKey)

  const packed = await packPlugin({
    distDir: dist,
    outDir: join(root, 'out'),
    privateKey: signer.privateKey,
  })
  tarball = readFileSync(packed.tarball)
  entry = {
    id: 'fixture',
    version: '1.0.0',
    sha256: packed.sha256,
    sig: packed.sig,
    keyId: packed.keyId,
  }
  trust = await Effect.runPromise(loadPluginTrust({ keysDir, dataDir }))
})

const run = (t: Uint8Array, e: EntryToVerify, tr: PluginTrust = trust) =>
  Effect.runSyncExit(verifyPlugin({ tarball: t, entry: e, trust: tr }))

const refusal = (t: Uint8Array, e: EntryToVerify, tr?: PluginTrust) => {
  const exit = run(t, e, tr)
  if (Exit.isSuccess(exit)) throw new Error('expected a refusal')
  const error = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (error?._tag !== 'Fail') throw new Error('expected a typed failure')
  return error.error
}

const expectRefused = (
  code: RefusalCode,
  t: Uint8Array,
  e: EntryToVerify,
  tr?: PluginTrust,
) => {
  const r = refusal(t, e, tr)
  expect(r.code).toBe(code)
  console.info(`[verify] ${r.code}: ${r.reason}`)
  return r
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const signWith = (key: KeyObject, b: Uint8Array) =>
  sign(null, b, key).toString('base64')

/** A one-entry ustar with an arbitrary header — what the SDK's writer won't make. */
const rawTar = (path: string, typeflag: string, linkname = '') => {
  const h = new Uint8Array(512)
  const put = (at: number, s: string) => h.set(new TextEncoder().encode(s), at)
  put(0, path)
  put(100, '0000644\0')
  put(108, '0000000\0')
  put(116, '0000000\0')
  put(124, '00000000000\0')
  put(136, '00000000000\0')
  h.fill(0x20, 148, 156)
  put(156, typeflag)
  put(157, linkname)
  put(257, 'ustar\0')
  put(263, '00')
  const sum = h.reduce((a, b) => a + b, 0)
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `)
  const out = new Uint8Array(512 * 3)
  out.set(h)
  return gzipSync(out)
}

/** A correctly signed archive whose contents are hostile. */
const signedHostile = (t: Uint8Array): [Uint8Array, EntryToVerify] => [
  t,
  { ...entry, sha256: sha(t), sig: signWith(signer.privateKey, t) },
]

describe('verifyPlugin', () => {
  it('accepts a correctly signed archive', () => {
    const exit = run(tarball, entry)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.warning).toBeNull()
      expect([...exit.value.files.keys()].sort()).toEqual([
        'bundle.mjs',
        'manifest.json',
      ])
      expect(exit.value.manifest).toEqual(manifest)
    }
  })

  it('refuses a flipped byte as a sha mismatch', () => {
    const flipped = Uint8Array.from(tarball)
    flipped[40] = (flipped.at(40) ?? 0) ^ 0xff
    expectRefused('sha-mismatch', flipped, entry)
  })

  it('refuses a wrong signature', () => {
    const other = keypair()
    expectRefused('bad-signature', tarball, {
      ...entry,
      sig: signWith(other.privateKey, tarball),
    })
  })

  it('refuses a re-hashed tamper — the sha matches, the signature does not', () => {
    const flipped = Uint8Array.from(tarball)
    flipped[40] = (flipped.at(40) ?? 0) ^ 0xff
    expectRefused('bad-signature', flipped, { ...entry, sha256: sha(flipped) })
  })

  it('refuses an unknown key id', () => {
    expectRefused('unknown-key', tarball, {
      ...entry,
      keyId: 'ed25519-0000000000000000',
    })
  })

  it('refuses an unsigned archive with the escape off', () => {
    expectRefused('unsigned', tarball, { ...entry, sig: null, keyId: null })
  })

  it('refuses a manifest id that disagrees with the registry entry', () => {
    const r = expectRefused('manifest-mismatch', tarball, {
      ...entry,
      id: 'apollo',
    })
    expect(r.reason).toContain('fixture@1.0.0')
  })

  it.each([
    ['a climbing path', rawTar('../evil.mjs', '0')],
    ['a nested climb', rawTar('migrations/../../evil.sql', '0')],
    ['an absolute path', rawTar('/etc/cron.d/evil', '0')],
    ['a symlink out', rawTar('bundle.mjs', '2', '/etc/passwd')],
    ['a hardlink', rawTar('bundle.mjs', '1', '../../secret.key')],
    ['a device', rawTar('dev', '3')],
  ])('refuses %s as an unsafe entry', (_, hostile) => {
    expectRefused('unsafe-entry', ...signedHostile(hostile))
  })

  it('refuses bytes that are not a gzip ustar', () => {
    expectRefused(
      'unreadable',
      ...signedHostile(new TextEncoder().encode('not a tarball')),
    )
  })

  it('verifies an unsigned archive with the escape on, saying so', async () => {
    writeFileSync(allowUnsignedMarker(dataDir), '')
    const escaped = await Effect.runPromise(
      loadPluginTrust({ keysDir, dataDir }),
    )
    expect(escaped.allowUnsigned).toBe(true)
    const exit = run(tarball, { ...entry, sig: null, keyId: null }, escaped)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.warning).toBe(UNSIGNED_ALLOWED)
      expect(UNSIGNED_ALLOWED).toBe('unsigned (allowed by .allow-unsigned)')
    }
  })
})

describe('loadPluginTrust', () => {
  it('trusts a key only under the id its bytes hash to', async () => {
    const dir = tmp('keys')
    const good = keypair()
    const liar = keypair()
    writeKey(dir, good.publicKey)
    writeKey(dir, liar.publicKey, keyIdOf(good.publicKey).replace(/.$/, 'x'))
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    const loaded = await Effect.runPromise(
      loadPluginTrust({ keysDir: dir, dataDir: tmp('data') }),
    )
    expect([...loaded.keys.keys()]).toEqual([keyIdOf(good.publicKey)])
    expect(loaded.allowUnsigned).toBe(false)
  })

  it('trusts nothing when the key directory is absent', async () => {
    const loaded = await Effect.runPromise(
      loadPluginTrust({ keysDir: join(tmp('none'), 'missing'), dataDir }),
    )
    expect(loaded.keys.size).toBe(0)
  })
})

describe('the required env stays { DATABASE_URL, APP_URL }', () => {
  it('loads trust and verifies with only those two set', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const script = `
      import { Effect } from 'effect'
      import { loadPluginTrust } from '${here}trust.ts'
      import { verifyPlugin } from '${here}verify.ts'
      const trust = await Effect.runPromise(loadPluginTrust({ keysDir: ${JSON.stringify(keysDir)} }))
      const tarball = new Uint8Array(Buffer.from(${JSON.stringify(Buffer.from(tarball).toString('base64'))}, 'base64'))
      const v = await Effect.runPromise(verifyPlugin({ tarball, entry: ${JSON.stringify(entry)}, trust }))
      console.log(JSON.stringify({ keys: trust.keys.size, warning: v.warning }))
    `
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        script,
      ],
      {
        cwd: here,
        encoding: 'utf8',
        env: {
          DATABASE_URL: 'postgresql://spaces:spaces@localhost:5432/spaces',
          APP_URL: 'http://localhost:3000',
        },
      },
    )
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ keys: 1, warning: null })
  })
})
