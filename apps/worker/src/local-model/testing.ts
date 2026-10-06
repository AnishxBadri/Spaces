import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  localModelDir,
  localModelPresent,
} from '@spaces/core/writes/ai/local-model-files'
import type { LocalModelSpec } from '@spaces/core/ai/local-model'
import type { LoadOptions, ModelLoader } from './host'

/**
 * A fake transformers.js for tests: no network, no weights, no runtime.
 * - `embed` answers a deterministic, normalized `dims`-wide vector per text.
 * - With downloads allowed it writes the model's files under the models root
 *   (as the file cache would), reporting progress per file.
 * - `requireFiles` makes a load without downloads fail when files are absent.
 */

export type FakeLoaderCounts = {
  loads: number
  disposes: number
  /** Every batch `embed` was handed, in order. */
  batches: Array<ReadonlyArray<string>>
  /** Every file a download wrote, in order, across loads. */
  written: Array<string>
}

export type FakeLoaderOptions = {
  readonly requireFiles?: boolean
  /** Awaited after the first progress report of a download. */
  readonly midDownload?: () => Promise<void>
  /** Added to every `embed` call. */
  readonly latencyMs?: number
  /** The first download fails after writing this many files. */
  readonly failFirstDownloadAfter?: number
}

/** A unit vector derived from `text`: same text, same vector. */
export function fakeVector(text: string, dims: number): Array<number> {
  const seed = createHash('sha256').update(text).digest()
  const raw = Array.from(
    { length: dims },
    (_, i) => (seed[i % seed.length] - 127.5) / 127.5 + i / dims,
  )
  const norm = Math.hypot(...raw)
  return raw.map((v) => v / norm)
}

/**
 * Writes the files a cache would, skipping any already finished — the
 * file cache's resume — and stopping with an error after `failAfter` new
 * files, as a dropped connection or a killed worker would.
 */
async function writeFiles(
  spec: LocalModelSpec,
  options: LoadOptions,
  written: Array<string> = [],
  failAfter = Number.POSITIVE_INFINITY,
) {
  const dir = localModelDir(spec)
  const total = spec.files.length * 1_000_000
  let loaded = 0
  let fresh = 0
  for (const file of spec.files) {
    const path = join(dir, ...file.split('/'))
    const done = await stat(path).then(
      () => true,
      () => false,
    )
    if (!done) {
      if (fresh >= failAfter) throw new Error('the connection dropped')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `fake ${file}`)
      written.push(file)
      fresh += 1
    }
    loaded += 1_000_000
    options.onProgress?.({ loaded, total })
  }
}

export function fakeLoader(options: FakeLoaderOptions = {}): {
  load: ModelLoader
  counts: FakeLoaderCounts
} {
  const counts: FakeLoaderCounts = {
    loads: 0,
    disposes: 0,
    batches: [],
    written: [],
  }
  let downloads = 0
  const load: ModelLoader = async (spec, load) => {
    counts.loads += 1
    if (load.allowDownload) {
      downloads += 1
      load.onProgress?.({ loaded: 0, total: spec.files.length * 1_000_000 })
      await options.midDownload?.()
      await writeFiles(
        spec,
        load,
        counts.written,
        downloads === 1 ? options.failFirstDownloadAfter : undefined,
      )
    } else if (options.requireFiles && !(await localModelPresent(spec)))
      throw new Error(`${spec.repo}: local files are missing`)
    return {
      embed: async (texts) => {
        counts.batches.push(texts)
        const latency = options.latencyMs ?? 0
        if (latency > 0)
          await new Promise((resolve) => setTimeout(resolve, latency))
        return texts.map((t) => fakeVector(t, spec.dims))
      },
      dispose: async () => {
        counts.disposes += 1
      },
    }
  }
  return { load, counts }
}

/** Puts the model's files on disk by hand, as an air-gapped operator would. */
export async function copyModelByHand(spec: LocalModelSpec): Promise<void> {
  await writeFiles(spec, { allowDownload: true })
}
