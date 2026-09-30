import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  TarFormatError,
  keyIdOf,
  packPlugin,
  readTar,
  registrySchema,
  writeTar,
} from './index.ts'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('ustar', () => {
  it('round-trips files and the directories they imply', () => {
    const tar = writeTar([
      { path: 'manifest.json', data: bytes('{"id":"x"}') },
      { path: 'migrations/0001_init.sql', data: bytes('create table t ();') },
      { path: 'empty.txt', data: new Uint8Array(0) },
    ])
    expect(tar.length % 512).toBe(0)
    const entries = readTar(tar)
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ['empty.txt', 'file'],
      ['manifest.json', 'file'],
      ['migrations', 'directory'],
      ['migrations/0001_init.sql', 'file'],
    ])
    expect(text(entries[3]?.data ?? new Uint8Array())).toBe(
      'create table t ();',
    )
  })

  it('is deterministic — the same files pack to the same bytes', () => {
    const files = [
      { path: 'b.txt', data: bytes('b') },
      { path: 'a.txt', data: bytes('a') },
    ]
    expect(writeTar(files)).toEqual(writeTar([...files].reverse()))
  })

  it('carries a path longer than 100 bytes in the prefix field', () => {
    const deep = `${'d'.repeat(80)}/${'e'.repeat(80)}/file.txt`
    expect(
      readTar(writeTar([{ path: deep, data: bytes('x') }])).at(-1)?.path,
    ).toBe(deep)
  })

  it('rejects a corrupted header', () => {
    const tar = writeTar([{ path: 'a.txt', data: bytes('a') }])
    tar[0] = 0x5a
    expect(() => readTar(tar)).toThrow(TarFormatError)
  })

  it('rejects a truncated archive', () => {
    const tar = writeTar([{ path: 'a.txt', data: bytes('a'.repeat(2000)) }])
    expect(() => readTar(tar.subarray(0, 1024))).toThrow(TarFormatError)
  })
})

const manifest = {
  manifestVersion: 1,
  id: 'packed',
  version: '2.1.0',
  sdk: '^1.0',
  name: 'Packed',
  description: 'A plugin for the packer tests.',
  settings: { type: 'object', properties: {} },
  jobs: { run: { trigger: 'action', uses: ['Log'] } },
}

const distWith = (files: Record<string, string>) => {
  const dist = join(mkdtempSync(join(tmpdir(), 'spaces-pack-')), 'dist')
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dist, name, '..'), { recursive: true })
    writeFileSync(join(dist, name), body)
  }
  return dist
}

describe('packPlugin', () => {
  it('writes <id>-<version>.tgz, its sha256, its signature and a registry entry', async () => {
    const dist = distWith({
      'manifest.json': JSON.stringify(manifest),
      'bundle.mjs': 'export default {}\n',
      'migrations/0001_init.sql': 'create table plugin_packed.t ();\n',
    })
    const out = join(dist, '..', 'out')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const r = await packPlugin({
      distDir: dist,
      outDir: out,
      privateKey,
      tarballBaseUrl:
        'https://github.com/AnishxBadri/Spaces/releases/download/plugin-packed@2.1.0',
    })

    const tgz = readFileSync(join(out, 'packed-2.1.0.tgz'))
    expect(r.sha256).toBe(createHash('sha256').update(tgz).digest('hex'))
    expect(readFileSync(join(out, 'packed-2.1.0.tgz.sha256'), 'utf8')).toBe(
      `${r.sha256}  packed-2.1.0.tgz\n`,
    )
    const sig = readFileSync(join(out, 'packed-2.1.0.tgz.sig'), 'utf8').trim()
    expect(verify(null, tgz, publicKey, Buffer.from(sig, 'base64'))).toBe(true)
    expect(r.keyId).toBe(keyIdOf(publicKey))
    expect(r.keyId).toMatch(/^ed25519-[0-9a-f]{16}$/)

    expect(readTar(gunzipSync(tgz)).map((e) => e.path)).toEqual([
      'bundle.mjs',
      'manifest.json',
      'migrations',
      'migrations/0001_init.sql',
    ])
    const entry = JSON.parse(
      readFileSync(join(out, 'packed-2.1.0.json'), 'utf8'),
    )
    expect(registrySchema.parse([entry])).toEqual([r.entry])
    expect(entry).not.toHaveProperty('kind')
    expect(entry.tarball).toBe(
      'https://github.com/AnishxBadri/Spaces/releases/download/plugin-packed@2.1.0/packed-2.1.0.tgz',
    )
  })

  it('packs the same files to the same sha256', async () => {
    const files = {
      'manifest.json': JSON.stringify(manifest),
      'bundle.mjs': 'export default {}\n',
    }
    const a = await packPlugin({ distDir: distWith(files), outDir: tmpdir() })
    const b = await packPlugin({ distDir: distWith(files), outDir: tmpdir() })
    expect(a.sha256).toBe(b.sha256)
  })

  it('packs unsigned without a key, and writes no entry', async () => {
    const dist = distWith({
      'manifest.json': JSON.stringify(manifest),
      'bundle.mjs': '',
    })
    const r = await packPlugin({
      distDir: dist,
      outDir: join(dist, '..', 'out'),
    })
    expect([r.sig, r.keyId, r.entry]).toEqual([null, null, null])
  })

  it('refuses a dist without its build output', async () => {
    const dist = distWith({ 'manifest.json': JSON.stringify(manifest) })
    await expect(
      packPlugin({ distDir: dist, outDir: tmpdir() }),
    ).rejects.toThrow(/bundle\.mjs is missing/)
  })

  it('refuses a manifest the loader would refuse', async () => {
    const dist = distWith({
      'manifest.json': JSON.stringify({ ...manifest, kind: 'enricher' }),
      'bundle.mjs': '',
    })
    await expect(
      packPlugin({ distDir: dist, outDir: tmpdir() }),
    ).rejects.toThrow(/kind/)
  })
})

describe('the committed registry.json', () => {
  it('parses under registrySchema (no kind field, D51)', () => {
    const registry: unknown = JSON.parse(
      readFileSync(
        new URL('../../../../registry.json', import.meta.url),
        'utf8',
      ),
    )
    expect(() => registrySchema.parse(registry)).not.toThrow()
  })
})
