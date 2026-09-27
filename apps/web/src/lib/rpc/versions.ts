/**
 * The two clocks of the external API, in one place (D27). `capture.hello`
 * answers with both, which is what lets an installed capture extension tell
 * "update me" from breakage (CONTEXT.md integration map #8).
 *
 * - `API_VERSION` is the URL's version, the `v1` in `/api/v1`. It moves only
 *   when an existing field changes meaning or disappears; an additive field
 *   never moves it. An extension pins it and keeps working for the life of v1.
 * - `CAPTURE_SCHEMA_VERSION` is the capture payload's own version. It moves
 *   when the extension's payload shape changes. `POST /api/v1/capture`
 *   (SPA-111) is the payload it versions, and v1 is that payload's first
 *   shape.
 *
 * Plain constants with no Effect import, so a test or a future client can
 * read them without touching the API layer.
 */
export const API_VERSION = 1

export const CAPTURE_SCHEMA_VERSION = 1

/**
 * Every capture payload version this instance accepts: the current one and
 * each known older one it still reads (SPA-111). A capture whose
 * `captureSchemaVersion` is not listed is refused with a message that says
 * to update the extension and names this list — the "update me, never
 * breakage" half of integration map #8. Bumping `CAPTURE_SCHEMA_VERSION`
 * adds the new number here and keeps the old one for as long as the handler
 * still reads its shape.
 */
export const ACCEPTED_CAPTURE_SCHEMA_VERSIONS: ReadonlyArray<number> = [
  CAPTURE_SCHEMA_VERSION,
]

/** Every external procedure lives under this one prefix (D27). */
export const API_PREFIX = `/api/v${API_VERSION}` as const
