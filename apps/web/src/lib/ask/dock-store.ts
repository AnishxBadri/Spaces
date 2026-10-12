import { useSyncExternalStore } from 'react'
import { SCOPE_MAX, chipKey, withMention } from './page-scope'
import type { AskScopeChip } from './types'

/**
 * Ask's docked column, per browser: open or closed, its width, and the
 * thread it holds. (D70)
 * - Open state, width and thread survive a reload (localStorage); closing
 *   keeps the thread.
 * - A door hands over a draft (the text typed in Cmd-K) and asks for focus;
 *   those are one-shot and never stored.
 */

export const DOCK_MIN = 360
export const DOCK_MAX = 560
export const DOCK_DEFAULT = 408

export type DockState = {
  readonly open: boolean
  readonly width: number
  readonly threadId: string | null
  /** Text a door hands the composer; taken once. */
  readonly draft: string | null
  /** Bumped by every door, so the composer takes focus. */
  readonly focus: number
  /** The key of the page chip that was removed; another page's chip shows. */
  readonly cleared: string | null
  /** Chips `@` added, after the page's own. */
  readonly mentioned: ReadonlyArray<AskScopeChip>
}

const KEY = 'spaces.ask.dock'

const INITIAL: DockState = {
  open: false,
  width: DOCK_DEFAULT,
  threadId: null,
  draft: null,
  focus: 0,
  cleared: null,
  mentioned: [],
}

export const clampWidth = (w: number): number =>
  Math.round(Math.min(DOCK_MAX, Math.max(DOCK_MIN, w)))

/** The stored half, read leniently: anything unreadable is the default. */
export function readStored(
  raw: string | null,
): Pick<DockState, 'open' | 'width' | 'threadId'> {
  const fallback = { open: false, width: DOCK_DEFAULT, threadId: null }
  if (raw === null) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const open = 'open' in parsed && parsed.open === true
    const width =
      'width' in parsed && typeof parsed.width === 'number'
        ? clampWidth(parsed.width)
        : DOCK_DEFAULT
    const threadId =
      'threadId' in parsed && typeof parsed.threadId === 'string'
        ? parsed.threadId
        : null
    return { open, width, threadId }
  } catch {
    return fallback
  }
}

let state: DockState = INITIAL
let hydrated = false
const listeners = new Set<() => void>()

function hydrate() {
  if (hydrated || typeof window === 'undefined') return
  hydrated = true
  state = { ...state, ...readStored(window.localStorage.getItem(KEY)) }
}

function set(next: Partial<DockState>) {
  hydrate()
  state = { ...state, ...next }
  if (typeof window !== 'undefined')
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        open: state.open,
        width: state.width,
        threadId: state.threadId,
      }),
    )
  for (const l of listeners) l()
}

function subscribe(cb: () => void) {
  hydrate()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useAskDock(): DockState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  )
}

export type OpenAsk = {
  /** Text to start the composer with. */
  draft?: string
  /** A thread to show; omitted keeps the one held. */
  threadId?: string | null
}

/** Every door: Tab from Cmd-K, ⌘J, the sidebar row, "Ask about this". */
export function openAsk(opts: OpenAsk = {}) {
  hydrate()
  set({
    open: true,
    draft: opts.draft ?? null,
    focus: state.focus + 1,
    cleared: null,
    ...(opts.threadId === undefined ? {} : { threadId: opts.threadId }),
  })
}

export function closeAsk() {
  set({ open: false })
}

/** ⌘J: open empty, or close. */
export function toggleAsk() {
  hydrate()
  if (state.open) closeAsk()
  else openAsk()
}

export const setDockWidth = (width: number) => set({ width: clampWidth(width) })
export const setDockThread = (threadId: string | null) => set({ threadId })
export const takeDraft = () => set({ draft: null })
/** Remove the page's chip: the next turn reads beyond it. */
export const clearPageChip = (chip: AskScopeChip) =>
  set({ cleared: chipKey(chip) })

/** `@` chose a space or record: one more chip, the oldest giving way. */
export function addMention(chip: AskScopeChip) {
  hydrate()
  // One place is the page chip's.
  set({ mentioned: withMention(state.mentioned, chip, SCOPE_MAX - 1) })
}

export function removeMention(chip: AskScopeChip) {
  hydrate()
  set({
    mentioned: state.mentioned.filter((c) => chipKey(c) !== chipKey(chip)),
  })
}
