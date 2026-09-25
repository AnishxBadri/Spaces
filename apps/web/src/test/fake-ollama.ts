/**
 * An in-repo fake of Ollama's `POST /api/embed` (SPA-83), handed to a test as
 * a `fetch` — through `embedCallFor`'s transport argument, or stubbed over
 * the global one so the real vault → adapter path reaches it. Nothing leaves
 * the process.
 *
 * It answers the three things the Embeddings section's Test must tell apart,
 * in Ollama's own wire format:
 *
 * - a pulled model → 200 `{model, embeddings, total_duration, load_duration,
 *   prompt_eval_count}`, one `dims`-wide vector per input;
 * - a model the server has not pulled → 404 `{"error": "model \"<m>\" not
 *   found, try pulling it first"}`, what `ollama serve` says;
 * - `unreachable` → the `TypeError('fetch failed')` Node's fetch throws for a
 *   refused connection, its `ECONNREFUSED` one `cause` down.
 *
 * Every request is recorded, so a test asserts where a sensitive embed went
 * (or that it went nowhere).
 */

export type FakeOllamaCall = { url: string; body: unknown }

export type FakeOllamaOptions = {
  pulled: ReadonlyArray<string>
  /** The width of every vector answered; 768 unless said otherwise. */
  dims?: number
  /** The vector for one input; defaults to a deterministic spread. */
  vectorFor?: (text: string, index: number) => Array<number>
  unreachable?: boolean
}

export type FakeOllama = {
  fetch: typeof fetch
  calls: Array<FakeOllamaCall>
}

const spread = (width: number, seed: number): Array<number> =>
  Array.from({ length: width }, (_, i) =>
    Number((Math.cos(i * seed + seed) / 10).toFixed(6)),
  )

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined

export function fakeOllama(options: FakeOllamaOptions): FakeOllama {
  const dims = options.dims ?? 768
  const calls: Array<FakeOllamaCall> = []
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlOf(input)
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url, body })
    if (options.unreachable) {
      const refused = new Error(`connect ECONNREFUSED ${new URL(url).host}`)
      Reflect.set(refused, 'code', 'ECONNREFUSED')
      throw new TypeError('fetch failed', { cause: refused })
    }
    if (!url.endsWith('/api/embed') || init?.method !== 'POST')
      return json({ error: `unexpected ${init?.method ?? 'GET'} ${url}` }, 404)
    const model = field(body, 'model')
    const raw = field(body, 'input')
    const texts = Array.isArray(raw)
      ? raw.filter((t): t is string => typeof t === 'string')
      : []
    if (typeof model !== 'string' || !options.pulled.includes(model))
      return json(
        {
          error: `model "${String(model)}" not found, try pulling it first`,
        },
        404,
      )
    return json(
      {
        model,
        embeddings: texts.map((t, i) =>
          options.vectorFor ? options.vectorFor(t, i) : spread(dims, i + 1),
        ),
        total_duration: 1_000_000,
        load_duration: 1_000,
        prompt_eval_count: texts.length * 3,
      },
      200,
    )
  }
  return { fetch, calls }
}
