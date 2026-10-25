import { Layer } from 'effect'

/**
 * The services every HttpApi handler may yield: provided once, where the web
 * handler is built, never per request.
 *
 * - Same shape as `runJob`'s closed `Layer.Layer<TServices>` (no
 *   construction error, no requirements), provided to the router instead.
 * - Empty because `db` is a module-level import. A service both the web
 *   process and the worker need goes in a module both can import, added here
 *   and to its `runJob` call.
 * - Handlers are typed against `WebServices`, so yielding a service missing
 *   from this Layer does not compile.
 */
export type WebServices = never

export const WebLayer: Layer.Layer<WebServices> = Layer.empty
