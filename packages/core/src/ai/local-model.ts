/**
 * The local embedding model: the catalogue both processes read, and the two
 * notification channels of the web-to-worker seam. (D50)
 * - Web asks on `LOCAL_EMBED_REQUEST_CHANNEL` with an `embed_request` row id
 *   and waits on `LOCAL_EMBED_REPLY_CHANNEL` for the same id; the vector is
 *   in the row, never the payload.
 * - Pure: no node imports, so the settings section can read the catalogue.
 */

export const LOCAL_EMBED_REQUEST_CHANNEL = 'embed_request'
export const LOCAL_EMBED_REPLY_CHANNEL = 'embed_reply'

/** A model the worker can download and run in-process. */
export type LocalModelSpec = {
  /** The catalogue id, as pinned (`workspace.settings.embedding.model`). */
  id: string
  /** The Hugging Face repo; also its directory under `<dataDir>/models`. */
  repo: string
  /** transformers.js `dtype`; `q8` reads `onnx/model_quantized.onnx`. */
  dtype: 'q8'
  dims: number
  /** bge is CLS-pooled and normalized. */
  pooling: 'cls'
  /** Every file a load reads, relative to the repo directory. */
  files: ReadonlyArray<string>
  /** What the download weighs, for the button's hint. */
  approxMegabytes: number
}

export const LOCAL_EMBEDDING_MODELS: ReadonlyArray<LocalModelSpec> = [
  {
    id: 'bge-base-en-v1.5',
    repo: 'Xenova/bge-base-en-v1.5',
    dtype: 'q8',
    dims: 768,
    pooling: 'cls',
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
    ],
    approxMegabytes: 110,
  },
]

export const findLocalModel = (id: string): LocalModelSpec | undefined =>
  LOCAL_EMBEDDING_MODELS.find((m) => m.id === id)

/** The download's exclusive key: one run per model queued or active. */
export const modelDownloadKey = (model: string): string =>
  `model.download:${model}`

/** The Test's exclusive key. */
export const modelTestKey = (model: string): string => `model.test:${model}`
