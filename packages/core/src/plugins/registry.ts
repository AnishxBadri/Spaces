/**
 * The registry, read as versions: which entry is newest per plugin, and
 * whether it is newer than what a row has installed. Pure.
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

/** The newest entry for each plugin id, in the order ids first appear. */
export const newestPerPlugin = <T extends { id: string; version: string }>(
  entries: ReadonlyArray<T>,
): Array<T> => {
  const newest = new Map<string, T>()
  for (const entry of entries) {
    const held = newest.get(entry.id)
    if (held === undefined || compareVersions(entry.version, held.version) > 0)
      newest.set(entry.id, entry)
  }
  return [...newest.values()]
}

/**
 * How an integration is named wherever it is named as a source. Uninstall
 * keeps the row, so a value it filled still names it — with the removal.
 */
export const sinceRemoved = (name: string, removedAt: Date | null): string =>
  removedAt === null ? name : `${name}, since removed`
