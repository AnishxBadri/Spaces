import { createHash } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { plainRecord } from '../json'

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

/** Unknown keys refuse the lock rather than being dropped. */
const strict = { parseOptions: { onExcessProperty: 'error' } } as const

const nonEmpty = Schema.String.check(Schema.isMinLength(1))

export const lockEntrySchema = Schema.Struct({
  version: nonEmpty,
  sha256: Schema.String.check(
    Schema.isPattern(SHA256_HEX, {
      message: 'sha256 is 64 lowercase hex characters',
    }),
  ),
}).annotate(strict)

export const lockSchema = Schema.Struct({
  core: Schema.optional(nonEmpty),
  plugins: plainRecord(Schema.mutableKey(lockEntrySchema)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
}).annotate(strict)
export type Lock = typeof lockSchema.Type

/** Hex sha256 of a bundle's bytes — the value a lock entry pins. */
export const bundleSha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Where the lock sits under a plugins root. */
export const LOCK_FILE = 'lock.json'
