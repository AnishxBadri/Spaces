import { LocalStorage } from './local'
import { S3Storage } from './s3'
import type { Storage } from './types'

export type { Storage } from './types'

/**
 * Driver selection: STORAGE_DRIVER=local (default) | s3.
 * The S3 driver (@aws-sdk/client-s3, forcePathStyle for non-AWS) lands when
 * document upload is built — interface is frozen here so it's a drop-in.
 */
let instance: Storage | null = null

export function storage(): Storage {
  if (instance) return instance
  const driver = process.env.STORAGE_DRIVER ?? 'local'
  switch (driver) {
    case 'local':
      instance = new LocalStorage()
      return instance
    case 's3':
      instance = new S3Storage()
      return instance
    default:
      throw new Error(`Unknown STORAGE_DRIVER: ${driver}`)
  }
}
