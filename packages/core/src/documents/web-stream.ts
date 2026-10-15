import { Readable } from 'node:stream'

/**
 * A provider's web stream as the node `Readable` intake reads.
 * - A reader that stops early — the size meter destroying the stream —
 *   cancels the source, so the provider stops sending.
 */
export const readableOf = (stream: ReadableStream<Uint8Array>): Readable =>
  Readable.from(chunksOf(stream))

async function* chunksOf(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let done = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        done = true
        return
      }
      yield next.value
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
