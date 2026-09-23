import { Effect, Option, Schema } from 'effect'
import { APICallError } from 'ai'
import { ProviderCallFailed } from '../../complete'
import { EMBEDDING_PROVIDER_INFO } from './ids'
import type { EmbedAdapterInput, EmbedAnswer, EmbedCall } from './adapter'

/**
 * The Voyage embedding adapter (SPA-51). Voyage has no AI SDK provider
 * installed, so this is `POST /v1/embeddings` over `fetch` as an Effect, its
 * answer decoded through a Schema rather than trusted.
 *
 * Every Voyage model in the catalogue is greyed today — `output_dimension`
 * accepts 256, 512, 1024 or 2048 and never 768 — so nothing reaches this
 * adapter until a same-width model or a re-pin exists. It is built now so
 * that is a catalogue row, not a transport.
 *
 * A refusal is raised as the SDK's own `APICallError`, so the settings Test
 * call's `providerFailure` reads Voyage's status and words the same way it
 * reads every other provider's.
 */

const VoyageResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      embedding: Schema.Array(Schema.Number),
      index: Schema.Number,
    }),
  ),
  usage: Schema.optionalKey(
    Schema.Struct({ total_tokens: Schema.optionalKey(Schema.Number) }),
  ),
})

const VoyageError = Schema.Struct({ detail: Schema.String })

const decodeResponse = Schema.decodeUnknownEffect(VoyageResponse)
const decodeError = Schema.decodeUnknownOption(VoyageError)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function voyageEmbedCall(input: EmbedAdapterInput): EmbedCall {
  const base =
    input.meta.baseUrl ?? EMBEDDING_PROVIDER_INFO.voyage.defaultBaseUrl
  const url = `${base.replace(/\/+$/, '')}/embeddings`
  const send = input.fetch ?? globalThis.fetch
  const failed = (cause: unknown) =>
    new ProviderCallFailed({ provider: 'voyage', cause })

  return Effect.fn('voyageEmbed')(function* (
    texts: ReadonlyArray<string>,
  ): Effect.fn.Return<EmbedAnswer, ProviderCallFailed> {
    const body = {
      input: [...texts],
      model: input.modelId,
      input_type: 'document',
      output_dimension: input.dims,
    }
    const response = yield* Effect.tryPromise({
      try: () =>
        send(url, {
          method: 'POST',
          headers: {
            ...input.meta.headers,
            authorization: `Bearer ${input.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      catch: failed,
    })
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: failed,
    })
    if (!response.ok) {
      const detail = decodeError(parseJson(text))
      return yield* failed(
        new APICallError({
          message: Option.match(detail, {
            onNone: () => response.statusText,
            onSome: (d) => d.detail,
          }),
          url,
          requestBodyValues: body,
          statusCode: response.status,
          responseBody: text,
        }),
      )
    }
    const decoded = yield* decodeResponse(parseJson(text)).pipe(
      Effect.mapError(failed),
    )
    const ordered = [...decoded.data].sort((a, b) => a.index - b.index)
    return {
      embeddings: ordered.map((d) => [...d.embedding]),
      tokens: decoded.usage?.total_tokens ?? null,
    }
  })
}
