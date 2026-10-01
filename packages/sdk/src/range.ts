import { SDK_VERSION } from './version.ts'

/**
 * `manifest.sdk` against the host's SDK_VERSION — the loader's compatibility
 * check (docs/spec-plugin-sdk.md §6, §7 step 3). Hand-rolled on purpose:
 * `semver` is a dependency nowhere in the repo, and a manifest range needs
 * three operators, not the npm grammar. The three:
 *
 *   `^1.2.3`  >=1.2.3 <2.0.0   (npm's caret: the left-most non-zero part is
 *                               fixed, so `^0.2.3` is <0.3.0 and `^0.0.3`
 *                               is <0.0.4; missing parts are wildcards)
 *   `~1.2.3`  >=1.2.3 <1.3.0   (`~1` is <2.0.0)
 *   `1.2.3`   exactly 1.2.3
 *
 * No `>=`, no `||`, no hyphen ranges, no prerelease tags in a range: a
 * manifest that needs one is asking for something the loader cannot promise.
 * A prerelease *host* (`1.1.0-rc.1`) compares as its release triple.
 */

type Triple = readonly [number, number, number]

type Range = {
  readonly op: '^' | '~' | '='
  readonly lower: Triple
  readonly upper: Triple | null // exclusive; null for an exact range
}

const RANGE = /^([\^~]?)(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

/** A `major.minor.patch` version with an optional prerelease tag. */
export const isVersion = (v: string): boolean => VERSION.test(v)

const triple = (v: string): Triple | null => {
  const m = VERSION.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const compare = (a: Triple, b: Triple): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Parse one of the three range forms, or `null` when it is none of them. */
export const parseSdkRange = (range: string): Range | null => {
  const m = RANGE.exec(range.trim())
  if (!m) return null
  // Unmatched optional groups are undefined at runtime; the annotation says so.
  const groups: ReadonlyArray<string | undefined> = m
  const [, opText, majText, minText, patText] = groups
  const major = Number(majText)
  const minor = minText === undefined ? undefined : Number(minText)
  const patch = patText === undefined ? undefined : Number(patText)
  const lower: Triple = [major, minor ?? 0, patch ?? 0]
  if (opText === '') {
    // An exact range names a whole version: `1.2` is not a version.
    return minor === undefined || patch === undefined
      ? null
      : { op: '=', lower, upper: null }
  }
  if (opText === '~') {
    return {
      op: '~',
      lower,
      upper: minor === undefined ? [major + 1, 0, 0] : [major, minor + 1, 0],
    }
  }
  const upper: Triple =
    major > 0 || minor === undefined
      ? [major + 1, 0, 0]
      : minor > 0 || patch === undefined
        ? [0, minor + 1, 0]
        : [0, 0, patch + 1]
  return { op: '^', lower, upper }
}

export type SdkCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Whether `host` (default: this SDK's own version) satisfies `range`. A
 * refusal carries a sentence, not a boolean — it is exactly what the loader
 * writes as the integration's degraded reason (`requires sdk ^2.0, host
 * provides 1.0.0`), so it names both sides.
 */
export const satisfiesSdk = (
  range: string,
  host: string = SDK_VERSION,
): SdkCheck => {
  const parsed = parseSdkRange(range)
  if (!parsed) {
    return {
      ok: false,
      reason: `unreadable sdk range "${range}" — use ^x.y, ~x.y or x.y.z`,
    }
  }
  const h = triple(host)
  if (!h) return { ok: false, reason: `unreadable host sdk version "${host}"` }
  const fits =
    parsed.upper === null
      ? compare(h, parsed.lower) === 0
      : compare(h, parsed.lower) >= 0 && compare(h, parsed.upper) < 0
  return fits
    ? { ok: true }
    : { ok: false, reason: `requires sdk ${range}, host provides ${host}` }
}
