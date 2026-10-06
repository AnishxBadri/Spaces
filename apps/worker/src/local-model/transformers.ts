import { modelsRoot } from '@spaces/core/writes/ai/local-model-files'
import type { LoadedModel, ModelLoader } from './host'

/**
 * The production `ModelLoader`: transformers.js, imported on first use so a
 * worker that never loads a local model never loads the library either.
 * - Files are read from and cached in `<dataDir>/models/<repo>/…`; a file
 *   finished before a restart is not fetched again.
 * - Web never imports this package (eslint `WEB_NEVER_LOADS_A_MODEL`).
 */
export const transformersLoader: ModelLoader = async (spec, options) => {
  const { env, pipeline } = await import('@huggingface/transformers')
  const root = modelsRoot()
  env.cacheDir = root
  env.localModelPath = root
  env.allowLocalModels = true
  env.allowRemoteModels = options.allowDownload
  const onProgress = options.onProgress
  const extractor = await pipeline('feature-extraction', spec.repo, {
    dtype: spec.dtype,
    cache_dir: root,
    local_files_only: !options.allowDownload,
    ...(onProgress === undefined
      ? {}
      : {
          progress_callback: (info) => {
            if (info.status === 'progress_total')
              onProgress({ loaded: info.loaded, total: info.total })
          },
        }),
  })
  const model: LoadedModel = {
    embed: async (texts) => {
      const out = await extractor([...texts], {
        pooling: spec.pooling,
        normalize: true,
      })
      const [rows = 0, width = 0] = out.dims
      const data = out.data
      const vectors: Array<Array<number>> = []
      for (let r = 0; r < rows; r += 1) {
        const row: Array<number> = []
        for (let c = 0; c < width; c += 1) row.push(Number(data[r * width + c]))
        vectors.push(row)
      }
      return vectors
    },
    dispose: () => extractor.dispose(),
  }
  return model
}
