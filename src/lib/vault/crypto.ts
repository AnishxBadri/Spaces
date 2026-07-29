import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { loadMasterKey } from './key'

/**
 * Envelope encryption for BYOK secrets. AES-256-GCM.
 * AAD binds ciphertext to its context (`scope:provider`) so a row copied
 * between credentials fails authentication instead of decrypting.
 *
 * Wire format: [1B version][12B iv][16B auth tag][ciphertext]
 */

const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16

export function encryptSecret(plaintext: string, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', loadMasterKey(), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext])
}

export function decryptSecret(blob: Buffer, aad: string): string {
  const version = blob[0]
  if (version !== VERSION) {
    throw new Error(`Unknown vault blob version ${version}`)
  }
  const iv = blob.subarray(1, 1 + IV_BYTES)
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
  const ciphertext = blob.subarray(1 + IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', loadMasterKey(), iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8',
  )
}

/** UI display form — never return the secret itself to the client. */
export function redact(secret: string): string {
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`
}
