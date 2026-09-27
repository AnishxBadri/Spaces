/**
 * The two clocks of the external API, in one place (D27). `capture.hello`
 * answers with both, which is what lets an installed capture extension tell
 * "update me" from breakage (CONTEXT.md integration map #8).
 *
 * - `API_VERSION` is the URL's version, the `v1` in `/api/v1`. It moves only
 *   when an existing field changes meaning or disappears; an additive field
 *   never moves it. An extension pins it and keeps working for the life of v1.
 * - `CAPTURE_SCHEMA_VERSION` is the capture payload's own version. It moves
 *   when the extension's payload shape changes — the `/api/capture` slice
 *   (SPA-111) is its first mover.
 *
 * Plain constants with no Effect import, so a test or a future client can
 * read them without touching the API layer.
 */
export const API_VERSION = 1

export const CAPTURE_SCHEMA_VERSION = 1

/** Every external procedure lives under this one prefix (D27). */
export const API_PREFIX = `/api/v${API_VERSION}` as const
