import { SDK_VERSION, isVersion, satisfiesSdk } from '@spaces/sdk'
import { CORE_VERSION } from './core-version.ts'

/**
 * The registry, read as versions: which entries this host can run, the
 * newest of them per plugin, and the update an installed row is offered.
 * Pure.
 */

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/

/**
 * Negative when `a` is older than `b`, positive when newer, zero when equal.
 * A prerelease sorts before its release; two prereleases compare as text.
 * An unparseable version sorts before every parseable one.
 */
export const compareVersions = (a: string, b: string): number => {
  const ma = VERSION.exec(a)
  const mb = VERSION.exec(b)
  if (!ma || !mb) return (ma ? 1 : 0) - (mb ? 1 : 0)
  for (const i of [1, 2, 3]) {
    const d = Number(ma[i]) - Number(mb[i])
    if (d !== 0) return d
  }
  // Unmatched optional groups are undefined at runtime; the annotation says so.
  const ga: ReadonlyArray<string | undefined> = ma
  const gb: ReadonlyArray<string | undefined> = mb
  const pa = ga[4]
  const pb = gb[4]
  if (pa === pb) return 0
  if (pa === undefined) return 1
  if (pb === undefined) return -1
  return pa < pb ? -1 : 1
}

/** What a registry entry is checked against: this core's version and its sdk's. */
export type HostVersions = { readonly core: string; readonly sdk: string }

export const THIS_HOST: HostVersions = { core: CORE_VERSION, sdk: SDK_VERSION }

/** The fields of a registry entry the satisfying rule reads. */
export type VersionedEntry = {
  readonly id: string
  readonly version: string
  /** The entry's sdk range, `^1.0`. */
  readonly sdk: string
  /** The oldest core it runs on; absent means any. */
  readonly minCore?: string | undefined
}

export type Runnable =
  { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Whether `host` can run `entry`: its `minCore` is at or below this core and
 * its sdk range admits this sdk. A refusal is the sentence the ledger shows,
 * naming the entry's version and both sides.
 */
export const runsOn = (
  entry: VersionedEntry,
  host: HostVersions = THIS_HOST,
): Runnable => {
  const { minCore } = entry
  if (minCore !== undefined) {
    if (!isVersion(minCore))
      return {
        ok: false,
        reason: `${entry.version} names an unreadable minCore "${minCore}"`,
      }
    if (compareVersions(host.core, minCore) < 0)
      return {
        ok: false,
        reason: `${entry.version} needs Spaces ${minCore} or newer; this is ${host.core}`,
      }
  }
  if (!satisfiesSdk(entry.sdk, host.sdk).ok)
    return {
      ok: false,
      reason: `${entry.version} needs sdk ${entry.sdk}; this host provides ${host.sdk}`,
    }
  return { ok: true }
}

const newestOf = <T extends VersionedEntry>(
  entries: ReadonlyArray<T>,
): T | undefined =>
  entries.reduce<T | undefined>(
    (held, e) =>
      held === undefined || compareVersions(e.version, held.version) > 0
        ? e
        : held,
    undefined,
  )

/**
 * The newest entry this host can run for each plugin id, in the order ids
 * first appear. An entry it cannot run is never offered — not to install,
 * not to upgrade to.
 */
export const newestPerPlugin = <T extends VersionedEntry>(
  entries: ReadonlyArray<T>,
  host: HostVersions = THIS_HOST,
): Array<T> => {
  const runnable = entries.filter((e) => runsOn(e, host).ok)
  return [...new Set(runnable.map((e) => e.id))].flatMap((id) => {
    const newest = newestOf(runnable.filter((e) => e.id === id))
    return newest === undefined ? [] : [newest]
  })
}

export type UpdateOffer<T> = {
  /** The newest satisfying version past the installed one: the badge and the one click. */
  readonly target: T | null
  /** The registry's newest version when this host cannot run it, and why. */
  readonly held: { readonly version: string; readonly reason: string } | null
}

/**
 * The update an installed plugin is offered. Satisfying means newer than
 * `installed`, `minCore` met, and an sdk range admitting this host's sdk —
 * one rule for the badge, the Update click and
 * `SPACES_PLUGINS_AUTOUPDATE=compatible`.
 */
export const updateFor = <T extends VersionedEntry>(
  entries: ReadonlyArray<T>,
  pluginId: string,
  installed: string,
  host: HostVersions = THIS_HOST,
): UpdateOffer<T> => {
  const newer = entries.filter(
    (e) => e.id === pluginId && compareVersions(e.version, installed) > 0,
  )
  const target = newestOf(newer.filter((e) => runsOn(e, host).ok)) ?? null
  const newest = newestOf(newer)
  if (newest === undefined || newest === target) return { target, held: null }
  const refusal = runsOn(newest, host)
  return {
    target,
    held: refusal.ok
      ? null
      : { version: newest.version, reason: refusal.reason },
  }
}

/**
 * How an integration is named wherever it is named as a source. Uninstall
 * keeps the row, so a value it filled still names it — with the removal.
 */
export const sinceRemoved = (name: string, removedAt: Date | null): string =>
  removedAt === null ? name : `${name}, since removed`
