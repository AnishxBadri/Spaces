import { Layer } from 'effect'

/**
 * The web process's composed runtime — the services every HttpApi handler may
 * yield, provided once, where the web handler is built (`api.ts`), and never
 * per request (CONTEXT.md "Backend paradigm" #1: the runtime is provided once
 * at the seam).
 *
 * It has the worker's shape on purpose, not a second composition. `runJob`
 * (`apps/worker/src/run-job.ts`) takes a closed `Layer.Layer<TServices>` —
 * no construction error, no requirements — and provides it to one program;
 * this is the same closed `Layer.Layer<WebServices>`, provided to the HTTP
 * router instead. And it is empty for the same reason all but two of the
 * worker's jobs pass `Layer.empty`: `db` is a module-level import, and
 * `capture.hello` has no I/O at all. The two are not one module yet
 * because there is nothing to share: the worker has no process-wide Layer,
 * only per-job ones, and its one non-empty service (`ExtractionStore`) lives
 * in `apps/worker`, which the web process may not import. The first
 * service both processes need goes in a module both can import, and each
 * seam adds it here and to its `runJob` call.
 *
 * `api.ts` types its handlers against `WebServices`, so a handler that yields
 * a service missing from this Layer does not compile.
 */
export type WebServices = never

export const WebLayer: Layer.Layer<WebServices> = Layer.empty
