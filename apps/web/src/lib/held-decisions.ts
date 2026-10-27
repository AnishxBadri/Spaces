import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { toast } from 'sonner'
import { heldView, isAlreadyDecided } from '#/lib/inbox/held'
import type { HeldDecision, HeldVerb, HeldView } from '#/lib/inbox/held'

/**
 * Undo by holding the write. Deciding hides the row and shows a toast with
 * `Undo`; the server fn runs only when the hold runs out.
 * - Undo inside the hold: no request at all, and the row is back.
 * - Expiry: the write runs once. Success invalidates the router; a refusal
 *   brings the row back with the error; a decision another hand made first
 *   invalidates silently.
 * - The page going (`pagehide`) sends every held decision in one beacon;
 *   signing out runs them first.
 * One store for the shell, so in-app navigation neither cancels nor commits.
 */

/** How long a decision is held before it is written. */
export const HOLD_MS = 5_000

/** Where the beacon goes. */
export const HELD_BEACON_PATH = '/api/held-decisions'

export type HeldEntry = {
  verb: HeldVerb
  /** What the beacon sends if the page goes before the hold runs out. */
  decision: HeldDecision
  /** The write; it throws to refuse, with the sentence the toast shows. */
  commit: () => Promise<unknown>
  label: string
  /** When it was decided, epoch ms. */
  at: number
  /** False: the caller settles the row itself once the write lands. */
  invalidate: boolean
}

export type HoldInput = {
  decision: HeldDecision
  commit: () => Promise<unknown>
  label: string
  /** Defaults to true. */
  invalidate?: boolean
}

/** What the store reaches outside itself; the tests hand it fakes. */
export type HeldDeps = {
  now: () => number
  /** The toast with `Undo` and its drain line, by key. */
  show: (key: string, label: string, onUndo: () => void) => void
  dismiss: (key: string) => void
  error: (message: string) => void
  /** Sends the decisions; false when the browser would not queue it. */
  beacon: (decisions: ReadonlyArray<HeldDecision>) => boolean
}

type Snapshot = ReadonlyMap<string, HeldEntry>

const EMPTY: Snapshot = new Map()

export function createHeldDecisions(deps: HeldDeps) {
  let entries: Snapshot = EMPTY
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  // Written now: no longer undoable, still hidden until it settles.
  const writing = new Set<string>()
  const listeners = new Set<() => void>()
  let invalidate: () => Promise<unknown> = async () => undefined

  const publish = (next: Snapshot) => {
    entries = next
    for (const l of listeners) l()
  }
  const without = (key: string) => {
    if (!entries.has(key)) return
    const next = new Map(entries)
    next.delete(key)
    publish(next)
  }

  async function write(key: string) {
    const entry = entries.get(key)
    if (entry === undefined || writing.has(key)) return
    const timer = timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(key)
    writing.add(key)
    deps.dismiss(key)
    try {
      await entry.commit()
      if (entry.invalidate) await invalidate()
    } catch (failure) {
      if (isAlreadyDecided(failure)) await invalidate()
      else {
        // The row comes back where it was, and says why.
        without(key)
        deps.error(
          failure instanceof Error && failure.message !== ''
            ? failure.message
            : 'Could not do that',
        )
      }
    } finally {
      writing.delete(key)
      without(key)
    }
  }

  function undo(key: string): boolean {
    if (writing.has(key) || !entries.has(key)) return false
    const timer = timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(key)
    deps.dismiss(key)
    without(key)
    return true
  }

  function hold(key: string, input: HoldInput): void {
    if (entries.has(key)) return
    const entry: HeldEntry = {
      verb: input.decision.verb,
      decision: input.decision,
      commit: input.commit,
      label: input.label,
      at: deps.now(),
      invalidate: input.invalidate ?? true,
    }
    publish(new Map(entries).set(key, entry))
    deps.show(key, input.label, () => void undo(key))
    timers.set(
      key,
      setTimeout(() => void write(key), HOLD_MS),
    )
  }

  /** Write every held decision now, and wait for them: sign-out. */
  async function flush(): Promise<void> {
    await Promise.all([...entries.keys()].map((key) => write(key)))
  }

  /**
   * The page is going: every decision not already being written leaves in
   * one beacon, and the store empties without running a write itself.
   */
  function beaconAll(): void {
    const held = [...entries].filter(([key]) => !writing.has(key))
    if (held.length === 0) return
    for (const [key] of held) {
      const timer = timers.get(key)
      if (timer !== undefined) clearTimeout(timer)
      timers.delete(key)
      deps.dismiss(key)
    }
    deps.beacon(held.map(([, e]) => e.decision))
    const next = new Map(entries)
    for (const [key] of held) next.delete(key)
    publish(next)
  }

  return {
    hold,
    undo,
    flush,
    beaconAll,
    /** The router's refresh; the shell hands it over once it mounts. */
    setInvalidate(f: () => Promise<unknown>) {
      invalidate = f
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    snapshot: (): Snapshot => entries,
  }
}

export type HeldDecisions = ReturnType<typeof createHeldDecisions>

// The drain line runs for the hold, not the Toaster's default.
const holdStyle: CSSProperties & Record<'--toast-duration', string> = {
  '--toast-duration': `${String(HOLD_MS)}ms`,
}

/** The shell's one store. */
export const heldDecisions: HeldDecisions = createHeldDecisions({
  now: () => Date.now(),
  show: (key, label, onUndo) =>
    void toast(label, {
      id: key,
      duration: HOLD_MS,
      action: { label: 'Undo', onClick: onUndo },
      style: holdStyle,
    }),
  dismiss: (key) => void toast.dismiss(key),
  error: (message) => void toast.error(message),
  beacon: (decisions) =>
    navigator.sendBeacon(
      HELD_BEACON_PATH,
      new Blob([JSON.stringify({ decisions })], { type: 'application/json' }),
    ),
})

/** Every held decision, by key. */
export function useHeldDecisions(): Snapshot {
  return useSyncExternalStore(
    heldDecisions.subscribe,
    heldDecisions.snapshot,
    () => EMPTY,
  )
}

/** What the held decisions hide, for a surface's filter (`withoutHeld`, `isHeld`). */
export function useHeldView(): HeldView {
  const entries = useHeldDecisions()
  return useMemo(
    () => heldView([...entries.values()].map((e) => e.decision)),
    [entries],
  )
}

/** One key's held entry, if it is waiting out its hold. */
export function useHeldEntry(key: string): HeldEntry | undefined {
  return useHeldDecisions().get(key)
}

/**
 * The shell's half: hands the store the router's refresh, and sends every
 * held decision when the page goes. Mounted once, under `_app`.
 */
export function useHeldDecisionsHost(invalidate: () => Promise<unknown>) {
  useEffect(() => {
    heldDecisions.setInvalidate(invalidate)
  }, [invalidate])
  useEffect(() => {
    const leave = () => heldDecisions.beaconAll()
    window.addEventListener('pagehide', leave)
    return () => window.removeEventListener('pagehide', leave)
  }, [])
}
