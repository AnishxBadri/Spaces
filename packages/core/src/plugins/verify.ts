import { createHash, verify as verifySignature } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { Effect, Schema } from 'effect'
import { TarFormatError, readTar } from '@spaces/sdk/pack'
import type { TarEntry } from '@spaces/sdk/pack'

/**
 * Verify a plugin tarball before anything unpacks it (sdk-21a; D16's plugin
 * half as D54 builds it, docs/spec-plugin-sdk.md §9). Pure: bytes, the
 * registry entry that names them and the trust the caller loaded
 * (`./trust.ts`) in; the verified files or one named refusal out. Web's
 * installer (project 19) and the worker's loader both call it — it is here,
 * in core, because both import core and neither imports the other.
 *
 * The checks, in order — the first that fails is the refusal:
 *
 *   1. sha256 of the bytes equals the entry's             → `sha-mismatch`
 *   2. signed: the key id is trusted                      → `unknown-key`
 *      and the detached ed25519 signature verifies         → `bad-signature`
 *      unsigned: refused unless `.allow-unsigned` exists   → `unsigned`
 *   3. gunzip + ustar parse                               → `unreadable`
 *   4. every entry a regular file or directory, at a
 *      relative path with no `..` segment                  → `unsafe-entry`
 *   5. a root manifest.json whose id and version are the
 *      entry's                                             → `manifest-missing`
 *                                                            `manifest-mismatch`
 *
 * The signature is checked over the whole tarball before any byte of it is
 * parsed, so a malformed archive from an untrusted source never reaches the
 * tar reader. The manifest's full schema is the loader's to check (it knows
 * the host SDK version); this only proves the archive is the one the entry
 * names.
 */

export const REFUSAL_CODES = [
  'sha-mismatch',
  'unknown-key',
  'bad-signature',
  'unsigned',
  'unreadable',
  'unsafe-entry',
  'manifest-missing',
  'manifest-mismatch',
] as const
export type RefusalCode = (typeof REFUSAL_CODES)[number]

export class PluginRefused extends Schema.TaggedError<PluginRefused>()(
  'PluginRefused',
  { code: Schema.Literals(REFUSAL_CODES), reason: Schema.String },
) {}

/** What an unsigned archive verifies with when the escape is on. */
export const UNSIGNED_ALLOWED = 'unsigned (allowed by .allow-unsigned)'

/** The fields of a registry entry verification reads. */
export type EntryToVerify = {
  readonly id: string
  readonly version: string
  readonly sha256: string
  /** base64 detached signature; absent/null for an unsigned archive. */
  readonly sig?: string | null
  readonly keyId?: string | null
}

export type PluginTrust = {
  /** Trusted public keys by key id (`plugin-keys/<keyId>.pub`). */
  readonly keys: ReadonlyMap<string, KeyObject>
  /** `<dataDir>/plugins/.allow-unsigned` exists. */
  readonly allowUnsigned: boolean
}

export type VerifiedPlugin = {
  /** The parsed manifest.json — unvalidated beyond id and version. */
  readonly manifest: unknown
  /** Every regular file, by its relative path. */
  readonly files: ReadonlyMap<string, Uint8Array>
  /** Set when it verified with a caveat — today only `UNSIGNED_ALLOWED`. */
  readonly warning: string | null
}

/** 64 MiB unpacked: a plugin is a bundle and a few migrations, not a payload. */
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024

const refuse = (code: RefusalCode, reason: string) =>
  Effect.fail(new PluginRefused({ code, reason }))

/** A relative path of plain segments — no `..`, no `.`, no root, no drive. */
const unsafePath = (path: string): string | null => {
  if (path === '') return 'an entry with an empty path'
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
    return `an absolute path: ${path}`
  }
  if (
    path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
  ) {
    return `a path that climbs or is not normal: ${path}`
  }
  return null
}

const entryRefusal = (entry: TarEntry): string | null => {
  if (entry.type === 'symlink' || entry.type === 'hardlink') {
    return `a ${entry.type} (${entry.path} -> ${entry.linkname}); a plugin archive holds regular files and directories only`
  }
  if (entry.type === 'other') {
    return `an entry of type '${entry.typeflag}' (${entry.path}); a plugin archive holds regular files and directories only`
  }
  return unsafePath(entry.path)
}

const readManifest = (bytes: Uint8Array): unknown => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return parsed
  } catch {
    return undefined
  }
}

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined

export const verifyPlugin = Effect.fn('verifyPlugin')(function* (input: {
  readonly tarball: Uint8Array
  readonly entry: EntryToVerify
  readonly trust: PluginTrust
}): Effect.fn.Return<VerifiedPlugin, PluginRefused> {
  const { tarball, entry, trust } = input
  const label = `${entry.id}@${entry.version}`

  const sha = createHash('sha256').update(tarball).digest('hex')
  if (sha !== entry.sha256.toLowerCase()) {
    return yield* refuse(
      'sha-mismatch',
      `${label}: sha256 is ${sha}, the registry says ${entry.sha256}`,
    )
  }

  let warning: string | null = null
  if (!entry.sig || !entry.keyId) {
    if (!trust.allowUnsigned) {
      return yield* refuse(
        'unsigned',
        `${label} is unsigned, and unsigned plugins load only where ./data/plugins/.allow-unsigned exists`,
      )
    }
    warning = UNSIGNED_ALLOWED
  } else {
    const key = trust.keys.get(entry.keyId)
    if (!key) {
      return yield* refuse(
        'unknown-key',
        `${label} is signed by ${entry.keyId}, which this image does not trust`,
      )
    }
    const ok = verifySignature(
      null,
      tarball,
      key,
      Buffer.from(entry.sig, 'base64'),
    )
    if (!ok) {
      return yield* refuse(
        'bad-signature',
        `${label}: the signature does not verify under ${entry.keyId}`,
      )
    }
  }

  const entries = yield* Effect.try({
    try: () =>
      readTar(gunzipSync(tarball, { maxOutputLength: MAX_UNPACKED_BYTES })),
    catch: (cause) =>
      new PluginRefused({
        code: 'unreadable',
        reason: `${label} is not a readable gzip'd ustar archive: ${
          cause instanceof TarFormatError || cause instanceof Error
            ? cause.message
            : String(cause)
        }`,
      }),
  })

  const files = new Map<string, Uint8Array>()
  for (const e of entries) {
    const why = entryRefusal(e)
    if (why) return yield* refuse('unsafe-entry', `${label} contains ${why}`)
    if (e.type === 'file') files.set(e.path, e.data)
  }

  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) {
    return yield* refuse(
      'manifest-missing',
      `${label} has no manifest.json at its root`,
    )
  }
  const manifest = readManifest(manifestBytes)
  const id = fieldOf(manifest, 'id')
  const version = fieldOf(manifest, 'version')
  if (id !== entry.id || version !== entry.version) {
    return yield* refuse(
      'manifest-mismatch',
      `${label}: the archive's manifest says ${String(id)}@${String(version)}`,
    )
  }

  return { manifest, files, warning }
})
