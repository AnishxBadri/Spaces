import { Effect, Schema } from 'effect'
import { findLocalModel } from '@spaces/core/ai/local-model'
import type { LocalModelSpec } from '@spaces/core/ai/local-model'

/**
 * The worker's local embedding model: one lazily loaded instance, shared by
 * every job and every web request, disposed after an idle interval. (D50)
 * - transformers.js frees nothing on its own, so the idle timer is what
 *   gives the memory back; the next use loads again.
 * - A load never downloads unless the download job asks: a pinned model
 *   whose files are gone fails, it does not fetch behind the operator's back.
 * - Calls run one at a time on the one instance.
 */

export type DownloadProgress = { loaded: number; total: number }

export type LoadedModel = {
  readonly embed: (
    texts: ReadonlyArray<string>,
  ) => Promise<Array<Array<number>>>
  readonly dispose: () => Promise<void>
}

export type LoadOptions = {
  /** Fetch missing files from the Hub; only the download job asks. */
  readonly allowDownload: boolean
  readonly onProgress?: (progress: DownloadProgress) => void
}

/** transformers.js in production; a fake pipeline in every test. */
export type ModelLoader = (
  spec: LocalModelSpec,
  options: LoadOptions,
) => Promise<LoadedModel>

export class LocalModelUnavailable extends Schema.TaggedError<LocalModelUnavailable>()(
  'LocalModelUnavailable',
  { model: Schema.String, message: Schema.String },
) {}

/** How long an unused model stays in memory. */
export const LOCAL_MODEL_IDLE_MS = 10 * 60_000

export type LocalModelHost = {
  /** One vector per text, loading the model on first use. */
  readonly embed: (
    model: string,
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<Array<Array<number>>, LocalModelUnavailable>
  /** Loads with downloads allowed, which fetches whatever files are missing. */
  readonly download: (
    model: string,
    onProgress: (progress: DownloadProgress) => void,
  ) => Effect.Effect<void, LocalModelUnavailable>
  /** Whether `model` is in memory now, so the next call will not load. */
  readonly isLoaded: (model: string) => boolean
  /** Loads since the host was made — what the tests count. */
  readonly loads: () => number
  readonly dispose: () => Effect.Effect<void>
}

export type LocalModelHostOptions = {
  readonly load: ModelLoader
  readonly idleMs?: number
}

const ignore = () => undefined

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function makeLocalModelHost(
  options: LocalModelHostOptions,
): LocalModelHost {
  const idleMs = options.idleMs ?? LOCAL_MODEL_IDLE_MS
  let current: { model: string; loaded: Promise<LoadedModel> } | null = null
  let ready: string | null = null
  let busy = 0
  let loads = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let queue: Promise<unknown> = Promise.resolve()

  const release = async () => {
    const was = current
    current = null
    ready = null
    if (was === null) return
    const model = await was.loaded.catch(() => null)
    await model?.dispose().catch(ignore)
  }

  const disarm = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const arm = () => {
    disarm()
    timer = setTimeout(() => {
      timer = null
      if (busy === 0) void release()
    }, idleMs)
    timer.unref()
  }

  const ensure = async (
    spec: LocalModelSpec,
    load: LoadOptions,
  ): Promise<LoadedModel> => {
    if (current?.model === spec.id) return current.loaded
    await release()
    loads += 1
    const loaded = options.load(spec, load)
    const entry = { model: spec.id, loaded }
    current = entry
    loaded.then(
      () => {
        if (current === entry) ready = spec.id
      },
      () => {
        if (current === entry) current = null
      },
    )
    return loaded
  }

  /** Runs `work` with the model in hand, then re-arms the idle timer. */
  const using = <T>(
    model: string,
    load: LoadOptions,
    work: (m: LoadedModel) => Promise<T>,
  ): Effect.Effect<T, LocalModelUnavailable> => {
    const spec = findLocalModel(model)
    if (spec === undefined)
      return Effect.fail(
        new LocalModelUnavailable({
          model,
          message: `${model} is not a local model this version knows`,
        }),
      )
    return Effect.tryPromise({
      try: async () => {
        disarm()
        busy += 1
        try {
          const run = queue.then(async () => work(await ensure(spec, load)))
          queue = run.catch(ignore)
          return await run
        } finally {
          busy -= 1
          if (busy === 0) arm()
        }
      },
      catch: (cause) =>
        new LocalModelUnavailable({ model, message: messageOf(cause) }),
    })
  }

  return {
    embed: (model, texts) =>
      texts.length === 0
        ? Effect.succeed([])
        : using(model, { allowDownload: false }, (m) => m.embed(texts)),
    download: (model, onProgress) =>
      using(model, { allowDownload: true, onProgress }, async () => undefined),
    isLoaded: (model) => ready === model,
    loads: () => loads,
    dispose: () =>
      Effect.promise(async () => {
        disarm()
        await release()
      }),
  }
}
