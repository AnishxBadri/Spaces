import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * `<dataDir>/plugins/lock.json` — the third source of truth (docs/spec-plugin-
 * sdk.md §10): the row is intent, the disk is code present, and the lock is
 * what this box pinned. Pure: the shape and the digest, no file I/O. The
 * worker's loader reads it (sdk-11); the installer (project 19) will write
 * it, which is why it is in core — both import core, neither imports the
 * other.
 *
 * sdk-11 pins what the spec's sketch left loose (`{ core, plugins: { id:
 * version } }`): a plugin's entry carries the sha256 of the `bundle.mjs` it
 * pinned as well as its version, because the loader's check is "the bundle
 * on disk is the bundle that was installed", and a version string cannot
 * say that. Until the installer lands no box has a lock.json at all, so an
 * absent file and an absent entry both mean "unpinned" — the plugin loads
 * and the verdict says so — while an entry that disagrees with the bytes is
 * a refusal.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/

export const lockEntrySchema = z.strictObject({
  version: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX, {
    error: 'sha256 is 64 lowercase hex characters',
  }),
})
export type LockEntry = z.infer<typeof lockEntrySchema>

export const lockSchema = z.strictObject({
  core: z.string().min(1).optional(),
  plugins: z.record(z.string(), lockEntrySchema).default({}),
})
export type Lock = z.infer<typeof lockSchema>

/** Hex sha256 of a bundle's bytes — the value a lock entry pins. */
export const bundleSha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Where the lock sits under a plugins root. */
export const LOCK_FILE = 'lock.json'
