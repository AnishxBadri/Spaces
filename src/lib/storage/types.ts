import type { Readable } from 'node:stream'

/**
 * Storage abstraction per CONTEXT.md. Keys are content-addressed:
 * sha256 of the file. Same deck emailed to both partners → one blob,
 * two document rows. Dedupe free, immutable, cache-forever.
 *
 * Presigning matters: a 200MB deck must not stream through Node. The
 * local driver fakes it with a short-lived HMAC token on /api/blob/:key.
 */
export interface Storage {
  put: (
    key: string,
    data: Readable | Buffer,
    meta: { mime?: string },
  ) => Promise<void>
  /**
   * `filename` is the name the download lands under — the key is a digest
   * and carries none. S3 expresses this as response-content-disposition on
   * the presigned URL; the local driver has its own equivalent.
   */
  getDownloadUrl: (
    key: string,
    ttlSeconds: number,
    opts?: { filename?: string | undefined },
  ) => Promise<string>
  /**
   * `headers` must be sent verbatim with the PUT. The S3 driver bakes the
   * content checksum into the signature (x-amz-checksum-sha256), so the
   * bucket — not this app — verifies "same sha ⇒ same bytes" on arrival;
   * omitting the header fails the signature. Local returns none.
   */
  getUploadUrl: (
    key: string,
    ttlSeconds: number,
  ) => Promise<{ url: string; headers: Record<string, string> }>
  /** Whole blob into memory — the extraction worker's read path. */
  getBytes: (key: string) => Promise<Uint8Array>
  delete: (key: string) => Promise<void>
  exists: (key: string) => Promise<boolean>
}
