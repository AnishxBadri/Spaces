import { Effect } from 'effect'
import { ProviderCallFailed } from '../../complete'
import { requestLocalEmbeddingProgram } from '../../local-embed'
import type { EmbedAdapterInput, EmbedCall } from './adapter'

/**
 * The local model's adapter: no credential and no address. (D50)
 * - In the worker, which holds the model, `installLocalEmbedder` hands it the
 *   in-process call at boot, and every embed runs there.
 * - Anywhere else — web — the call goes through the `embed_request` seam
 *   (`requestLocalEmbeddingProgram`), bounded by its timeout.
 * - Tokens are not counted: nothing is billed.
 */

/** Texts in, one vector each out; the worker's in-process model. */
export type LocalEmbedder = (
  model: string,
  texts: ReadonlyArray<string>,
) => Effect.Effect<Array<Array<number>>, unknown>

let installed: LocalEmbedder | null = null

/** Makes this process the one that runs the model. Returns the uninstall. */
export function installLocalEmbedder(embedder: LocalEmbedder): () => void {
  installed = embedder
  return () => {
    if (installed === embedder) installed = null
  }
}

export function localEmbedCall(input: EmbedAdapterInput): EmbedCall {
  return (texts) => {
    const run = installed
    const vectors =
      run === null
        ? requestLocalEmbeddingProgram(input.modelId, texts)
        : run(input.modelId, texts)
    return vectors.pipe(
      Effect.map((embeddings) => ({ embeddings, tokens: null })),
      Effect.mapError(
        (cause) => new ProviderCallFailed({ provider: 'local', cause }),
      ),
    )
  }
}
