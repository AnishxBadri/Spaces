import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../vault/key'
import type { LocalModelSpec } from '../../ai/local-model'

/**
 * Where local model files live: `<dataDir>/models/<repo>/…`, the layout
 * transformers.js' file cache writes and its local-model lookup reads.
 * - Never baked into the image; the download job fills it on click.
 * - A directory copied there by hand counts the same as a download.
 */

export function modelsRoot(): string {
  return join(dataDir(), 'models')
}

export function localModelDir(
  spec: LocalModelSpec,
  root: string = modelsRoot(),
): string {
  return join(root, ...spec.repo.split('/'))
}

/** Every file a load reads is present and non-empty. */
export async function localModelPresent(
  spec: LocalModelSpec,
  root: string = modelsRoot(),
): Promise<boolean> {
  const dir = localModelDir(spec, root)
  for (const file of spec.files) {
    const size = await stat(join(dir, ...file.split('/'))).then(
      (s) => (s.isFile() ? s.size : 0),
      () => 0,
    )
    if (size === 0) return false
  }
  return true
}
