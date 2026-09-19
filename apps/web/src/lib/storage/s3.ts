import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Readable } from 'node:stream'
import type { Storage } from './types'

/**
 * S3 driver — opt-in via STORAGE_DRIVER=s3 (CONTEXT.md: local filesystem
 * stays the default; nothing is bundled). One driver covers every
 * S3-compatible target: AWS, Cloudflare R2, Backblaze B2, MinIO, Garage —
 * the operator brings a bucket like they bring an LLM key.
 *
 * Integrity: the local driver re-hashes bytes as it writes; a presigned PUT
 * bypasses this server entirely, so verification is delegated to the bucket
 * via x-amz-checksum-sha256 baked into the signature (checksum matrix,
 * researched 2026-08: AWS and MinIO verify and reject mismatches; R2 and B2
 * added support in 2024/2025; Garage is doubtful). Belt-and-braces for
 * partially-compatible endpoints: the extraction worker re-verifies the
 * digest of every blob it reads — see extract-document.
 *
 * Env (all optional unless the driver is selected):
 *   S3_BUCKET             required with STORAGE_DRIVER=s3
 *   S3_ENDPOINT           e.g. https://<account>.r2.cloudflarestorage.com;
 *                         empty for AWS proper
 *   S3_REGION             default us-east-1 ("auto" for R2 works too)
 *   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *   S3_FORCE_PATH_STYLE   default true — correct for R2/B2/MinIO/Garage;
 *                         set false only for AWS virtual-hosted style
 */

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required when STORAGE_DRIVER=s3`)
  return v
}

/** The bucket wants the raw digest base64-encoded; our keys are hex. */
function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64')
}

export class S3Storage implements Storage {
  private client: S3Client
  private bucket: string

  constructor() {
    this.bucket = required('S3_BUCKET')
    const endpoint = process.env.S3_ENDPOINT
    this.client = new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      credentials: {
        accessKeyId: required('S3_ACCESS_KEY_ID'),
        secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      },
    })
  }

  /** Server-side write (rare) — checksum still declared, bucket verifies. */
  async put(key: string, data: Readable | Buffer, meta: { mime?: string }) {
    const body = Buffer.isBuffer(data)
      ? data
      : await new Promise<Buffer>((resolve, reject) => {
          const chunks: Array<Buffer> = []
          data.on('data', (c: Buffer) => chunks.push(c))
          data.on('end', () => resolve(Buffer.concat(chunks)))
          data.on('error', reject)
        })
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: meta.mime ?? 'application/octet-stream',
        ChecksumSHA256: hexToBase64(key),
      }),
    )
  }

  /**
   * Same download hardening as the local blob route: attachment +
   * octet-stream are baked into the *signed* response params, so an
   * uploaded .html can never be served inline from the bucket either.
   */
  async getDownloadUrl(
    key: string,
    ttlSeconds: number,
    opts?: { filename?: string | undefined },
  ) {
    const safeName = (opts?.filename ?? key).replace(/[^\w.\- ()]/g, '_')
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
        ResponseContentType: 'application/octet-stream',
      }),
      { expiresIn: ttlSeconds },
    )
  }

  async getUploadUrl(key: string, ttlSeconds: number) {
    const checksum = hexToBase64(key)
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ChecksumSHA256: checksum,
      }),
      // Sign the checksum header so it cannot be omitted or altered: a PUT
      // without it (or with different bytes, on enforcing endpoints) fails.
      {
        expiresIn: ttlSeconds,
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      },
    )
    return { url, headers: { 'x-amz-checksum-sha256': checksum } }
  }

  async getBytes(key: string) {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )
    if (!res.Body) throw new Error(`Blob ${key} has no body`)
    return res.Body.transformToByteArray()
  }

  async delete(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    )
  }

  async exists(key: string) {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      return true
    } catch {
      return false
    }
  }
}
