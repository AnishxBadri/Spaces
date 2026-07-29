import { createHmac, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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

  async getDownloadUrl(key: string, ttlSeconds: number) {
    const exp = Date.now() + ttlSeconds * 1000
    const sig = signBlobToken(key, 'get', exp)
    return `${appUrl()}/api/blob/${key}?exp=${exp}&sig=${sig}`
  }

  async getUploadUrl(key: string, ttlSeconds: number) {
    const exp = Date.now() + ttlSeconds * 1000
    const sig = signBlobToken(key, 'put', exp)
    return `${appUrl()}/api/blob/${key}?exp=${exp}&sig=${sig}`
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
