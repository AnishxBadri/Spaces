import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Upload } from 'lucide-react'
import { openUploadDialog } from './upload-dialog-store'

/**
 * The verbs a page publishes to Cmd-K's Actions group. (D70)
 * - A route calls `usePageActions` once with its own verbs, record verbs
 *   first; the registration goes when the route unmounts.
 * - `key` is the page's own binding, printed on the row, so it must be one
 *   the page really binds. `runBinding` runs a verb through that binding,
 *   which keeps the row and the key one thing.
 * - A verb that needs one more answer carries a `step`: the palette asks it
 *   in place, with `step.mode` as the input's mode label.
 */

/** One answer a step offers. */
export type StepChoice = {
  readonly id: string
  readonly label: string
  /** Graphite lane on the right: `12 companies`, `filed here`. */
  readonly meta?: string
  /** Already true — drawn checked, and picking it does nothing. */
  readonly done?: boolean
}

export type ActionStep = {
  /** The input's mode label, `File in`; the palette adds the `›`. */
  readonly mode: string
  /** What the step acts on, printed at the input's right. */
  readonly subject: string
  readonly placeholder: string
  /** The foot's right lane: what a pick does. */
  readonly hint: string
  /** The group head over the choices. */
  readonly heading: string
  readonly choices: () => Promise<ReadonlyArray<StepChoice>>
  /**
   * Resolves with the choice as it now stands, once written; the palette
   * redraws it and stays open for another. Rejects when nothing was written.
   */
  readonly pick: (choice: StepChoice) => Promise<StepChoice>
}

type ActionFields = {
  readonly id: string
  readonly label: string
  /** The printed binding — `M`, `G T` — when the page binds one. */
  readonly key?: string
  readonly icon?: LucideIcon
  /** Words a typed query may match besides the label; never drawn. */
  readonly words?: string
}

export type PageAction =
  | (ActionFields & { readonly run: () => void })
  | (ActionFields & { readonly step: ActionStep })

/** Verbs every page has; the palette offers them once something is typed. */
export const GLOBAL_ACTIONS: ReadonlyArray<PageAction> = [
  {
    id: 'upload',
    label: 'Upload a file…',
    icon: Upload,
    words: 'upload file document deck attach drop',
    run: openUploadDialog,
  },
]

/**
 * Press a printed binding on the page: `'L'`, or a chord `'G T'`. The event
 * goes to the document, so `useHotkeys` treats it as the page's own key.
 */
export function runBinding(binding: string): () => void {
  return () => {
    for (const key of binding.toLowerCase().split(' ')) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      )
    }
  }
}

type Registration = { readonly current: ReadonlyArray<PageAction> }

/** Mounted registrations, newest first: the deepest route leads. */
let registrations: Array<Registration> = []
let snapshot: ReadonlyArray<PageAction> = []
const listeners = new Set<() => void>()

function publish() {
  snapshot = registrations.flatMap((r) => r.current)
  for (const l of listeners) l()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

const EMPTY: ReadonlyArray<PageAction> = []

/** What the palette reads: the mounted pages' verbs, in order. */
export function usePageActionsList(): ReadonlyArray<PageAction> {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  )
}

/**
 * The live copy of a registered verb, for the moment it runs: the snapshot
 * the palette drew may hold a closure from an earlier render.
 */
export function latestPageAction(id: string): PageAction | undefined {
  for (const r of registrations) {
    const found = r.current.find((a) => a.id === id)
    if (found) return found
  }
  return undefined
}

/** Publish this page's verbs to Cmd-K while the page is mounted. */
export function usePageActions(actions: ReadonlyArray<PageAction>) {
  const latest = useRef<ReadonlyArray<PageAction>>(actions)
  latest.current = actions
  // Re-publish when what is drawn changes; handlers are read live.
  const signature = actions
    .map((a) => `${a.id}\u0000${a.label}\u0000${a.key ?? ''}`)
    .join('\u0001')

  useEffect(() => {
    const reg: Registration = latest
    registrations = [reg, ...registrations]
    publish()
    return () => {
      registrations = registrations.filter((r) => r !== reg)
      publish()
    }
  }, [signature])
}
