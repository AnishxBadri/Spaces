import { LocalStorage } from './local'
import { S3Storage } from './s3'
import type { Storage } from './types'

export type { Storage } from './types'

/** Driver selection: STORAGE_DRIVER=local (default) | s3. */
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
