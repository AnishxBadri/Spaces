import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_UPLOAD_BYTES } from '#/lib/documents'
import { dataDir, loadMasterKey } from '#/lib/vault/key'
import type { Storage } from './types'

/**
 * Local filesystem driver — the default. Plain files the operator can open
 * in Finder and tar anywhere. Blobs at <DATA_DIR>/blobs/<aa>/<sha256>.
 *
 * "Presigned" URLs are app routes carrying a short-lived HMAC token, keyed
 * off the master key. GET /api/blob/:key?exp=...&sig=...
 */

export function blobPath(key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new Error('Blob keys are sha256 hex digests')
  }
  return join(dataDir(), 'blobs', key.slice(0, 2), key)
}

export function signBlobToken(
  key: string,
  verb: 'get' | 'put',
  expiresAtMs: number,
): string {
  return createHmac('sha256', loadMasterKey())
    .update(`blob:${verb}:${key}:${expiresAtMs}`)
    .digest('base64url')
}

export function verifyBlobToken(
  key: string,
  verb: 'get' | 'put',
  expiresAtMs: number,
  sig: string,
): boolean {
  if (Date.now() > expiresAtMs) return false
  const expected = signBlobToken(key, verb, expiresAtMs)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  return a.length === b.length && timingSafeEqual(a, b)
}

function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

export class LocalStorage implements Storage {
  async put(key: string, data: Readable | Buffer, _meta: { mime?: string }) {
    const path = blobPath(key)
    await mkdir(dirname(path), { recursive: true })
    const source = Buffer.isBuffer(data) ? Readable.from(data) : data
    await pipeline(source, createWriteStream(path, { mode: 0o600 }))
  }

  /**
   * Content-addressed write: bytes are hashed as they stream to a temp file
   * and land at their key only if the digest matches. Without this the key
   * is whatever the client claimed, and "same sha ⇒ same bytes" — which the
   * dedupe, the immutable cache header, and the extraction worker all rely
   * on — stops being true the first time a client lies or a upload truncates.
   *
   * S3 gets this from the service instead (checksum on presigned PUT); the
   * local driver has to do it itself because the app *is* the store.
   */
  async putContentAddressed(key: string, data: Readable): Promise<void> {
    const final = blobPath(key)
    const temp = join(dataDir(), 'blobs', '.incoming', randomUUID())
    await mkdir(dirname(temp), { recursive: true })

    const hash = createHash('sha256')
    let seen = 0
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length
        if (seen > MAX_UPLOAD_BYTES) {
          done(new Error(`Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit`))
          return
        }
        hash.update(chunk)
        done(null, chunk)
      },
    })

    try {
      await pipeline(data, meter, createWriteStream(temp, { mode: 0o600 }))
      const digest = hash.digest('hex')
      if (digest !== key) {
        throw new Error(`Content hash ${digest} does not match key ${key}`)
      }
      await mkdir(dirname(final), { recursive: true })
      await rename(temp, final)
    } finally {
      await rm(temp, { force: true })
    }
  }

  async getDownloadUrl(
    key: string,
    ttlSeconds: number,
    opts?: { filename?: string | undefined },
  ) {
    const exp = Date.now() + ttlSeconds * 1000
    const sig = signBlobToken(key, 'get', exp)
    // `name` sits outside the signature deliberately: it only decides the
    // filename on a download the holder is already authorized to make.
    const name = opts?.filename
      ? `&name=${encodeURIComponent(opts.filename)}`
      : ''
    return `${appUrl()}/api/blob/${key}?exp=${exp}&sig=${sig}${name}`
  }

  async getUploadUrl(key: string, ttlSeconds: number) {
    const exp = Date.now() + ttlSeconds * 1000
    const sig = signBlobToken(key, 'put', exp)
    // No headers: the app is the store here and re-hashes the stream itself.
    return {
      url: `${appUrl()}/api/blob/${key}?exp=${exp}&sig=${sig}`,
      headers: {},
    }
  }

  async getBytes(key: string) {
    return new Uint8Array(await readFile(blobPath(key)))
  }

  async delete(key: string) {
    await rm(blobPath(key), { force: true })
  }

  async exists(key: string) {
    return stat(blobPath(key)).then(
      () => true,
      () => false,
    )
  }
}
