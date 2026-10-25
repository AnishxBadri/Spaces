import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * `<dataDir>/plugins/lock.json` — what this box pinned, beside the row
 * (intent) and the disk (code present). Pure: shape and digest, no file I/O.
 * In core because the installer writes it and the worker's loader reads it.
 * - An entry pins the `bundle.mjs` sha256 as well as the version: the check
 *   is "the bundle on disk is the one installed", which a version can't say.
 * - An absent file or entry means unpinned: the plugin loads and the verdict
 *   says so. An entry that disagrees with the bytes is a refusal.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/

export const lockEntrySchema = z.strictObject({
  version: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX, {
    error: 'sha256 is 64 lowercase hex characters',
  }),
})

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
