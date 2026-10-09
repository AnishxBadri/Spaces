import { useSyncExternalStore } from 'react'
import { z } from 'zod'

/**
 * The chassis' per-browser memory: which groups are folded, which spaces are
 * starred and which saved views are pinned. Local to the browser like
 * `useTablePrefs` — no table, so a star or a pin does not follow the user to
 * another device (accepted for now).
 *
 * - Read through useSyncExternalStore: the server render and the first client
 *   render agree (nothing folded, nothing starred), and the stored state snaps
 *   in after hydration, as the collapsed chassis does.
 * - A snapshot is cached per raw string, so an unchanged key hands React the
 *   same array and no render loops.
 * - localStorage is a boundary: decoded, never asserted.
 */

/** The groups that fold. Work never does — it has no heading. */
export const FOLDABLE_GROUPS = ['library', 'objects', 'capital'] as const
export type FoldableGroup = (typeof FOLDABLE_GROUPS)[number]

export type StarredSpace = { readonly id: string; readonly name: string }

/** How many starred spaces stand under Spaces before `▸ n more`. */
export const STARRED_SHOWN = 5

/** How many pinned views stand under their object before `▸ n more`. */
export const PINNED_SHOWN = 3

/** The query key of the sidebar's pinned-view read; a view edit invalidates it. */
export const PINNED_VIEWS_QUERY = 'pinned-views'

const FOLDED_KEY = 'chassis:folded'
const STARRED_KEY = 'chassis:starred-spaces'
const PINNED_KEY = 'chassis:pinned-views'
const KEYS: ReadonlyArray<string> = [FOLDED_KEY, STARRED_KEY, PINNED_KEY]

const foldedCodec = z.array(z.enum(FOLDABLE_GROUPS))
const starredCodec = z.array(z.object({ id: z.string(), name: z.string() }))
const pinnedCodec = z.array(z.string().uuid())

const listeners = new Set<() => void>()

const EMPTY_FOLDED: ReadonlyArray<FoldableGroup> = []
const EMPTY_STARRED: ReadonlyArray<StarredSpace> = []
const EMPTY_PINNED: ReadonlyArray<string> = []

/** One key's snapshot, re-decoded only when the stored string changes. */
function snapshot<T>(key: string, codec: z.ZodType<T>, empty: T) {
  let last: { raw: string | null; value: T } | null = null
  return (): T => {
    const raw = rawOf(key)
    if (last?.raw === raw) return last.value
    last = { raw, value: decode(raw, codec) ?? empty }
    return last.value
  }
}

function rawOf(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const readFolded = snapshot<ReadonlyArray<FoldableGroup>>(
  FOLDED_KEY,
  foldedCodec,
  EMPTY_FOLDED,
)
const readStarred = snapshot<ReadonlyArray<StarredSpace>>(
  STARRED_KEY,
  starredCodec,
  EMPTY_STARRED,
)
const readPinned = snapshot<ReadonlyArray<string>>(
  PINNED_KEY,
  pinnedCodec,
  EMPTY_PINNED,
)

function decode<T>(raw: string | null, codec: z.ZodType<T>): T | null {
  if (raw === null) return null
  try {
    const parsed = codec.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / quota — the preference is lost, nothing else is */
  }
  for (const l of listeners) l()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && KEYS.includes(e.key)) cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

export function useFoldedGroups(): ReadonlyArray<FoldableGroup> {
  return useSyncExternalStore(subscribe, readFolded, () => EMPTY_FOLDED)
}

export function setGroupFolded(group: FoldableGroup, folded: boolean) {
  const rest = readFolded().filter((g) => g !== group)
  write(FOLDED_KEY, folded ? [...rest, group] : rest)
}

export function useStarredSpaces(): ReadonlyArray<StarredSpace> {
  return useSyncExternalStore(subscribe, readStarred, () => EMPTY_STARRED)
}

/**
 * Star or unstar a space. A new star goes to the end: the sidebar lists stars
 * in the order they were given.
 */
export function toggleStarredSpace(space: StarredSpace) {
  write(STARRED_KEY, toggledStars(readStarred(), space))
}

/** Keep a star's label in step with a renamed space, without moving it. */
export function syncStarredSpaceName(space: StarredSpace) {
  const stars = readStarred()
  if (!stars.some((s) => s.id === space.id && s.name !== space.name)) return
  write(
    STARRED_KEY,
    stars.map((s) => (s.id === space.id ? { id: s.id, name: space.name } : s)),
  )
}

export function toggledStars(
  stars: ReadonlyArray<StarredSpace>,
  space: StarredSpace,
): ReadonlyArray<StarredSpace> {
  return stars.some((s) => s.id === space.id)
    ? stars.filter((s) => s.id !== space.id)
    : [...stars, { id: space.id, name: space.name }]
}

/** The pinned view ids, in the order they were pinned. */
export function usePinnedViews(): ReadonlyArray<string> {
  return useSyncExternalStore(subscribe, readPinned, () => EMPTY_PINNED)
}

/** Pin or unpin a saved view. A new pin goes to the end. */
export function togglePinnedView(id: string) {
  write(PINNED_KEY, toggledPins(readPinned(), id))
}

export function toggledPins(
  pins: ReadonlyArray<string>,
  id: string,
): ReadonlyArray<string> {
  return pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]
}

/**
 * Drop the pins the server was asked about and did not answer — deleted, or
 * no longer readable. A pin added since the question was asked is kept.
 */
export function prunePinnedViews(
  asked: ReadonlyArray<string>,
  answered: ReadonlySet<string>,
) {
  const pins = readPinned()
  const next = prunedPins(pins, asked, answered)
  if (next.length !== pins.length) write(PINNED_KEY, next)
}

export function prunedPins(
  pins: ReadonlyArray<string>,
  asked: ReadonlyArray<string>,
  answered: ReadonlySet<string>,
): ReadonlyArray<string> {
  return pins.filter((id) => !asked.includes(id) || answered.has(id))
}
