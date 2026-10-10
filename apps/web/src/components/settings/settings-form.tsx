import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'

/**
 * How a settings page saves (D81).
 * - A switch, checkbox or select writes at once, with a toast; it never
 *   touches this module.
 * - A typed field (a name, a host, a port, a key) is a draft: it registers
 *   here through `useSettingsDraft`, and the page's one Save bar collects
 *   every dirty draft — "n changes", Discard, Save `⌘↵`.
 * - There is no per-section Save. `SettingsSection` opens a form when no page
 *   form is above it, so a section cannot draw a page without the bar.
 */

export type DraftValue = string | boolean
export type DraftValues = Readonly<Record<string, DraftValue>>

type Entry = {
  readonly dirty: number
  readonly save: () => Promise<void>
  readonly discard: () => void
}

type Form = {
  readonly register: (id: string, entry: Entry) => () => void
}

const FormContext = createContext<Form | null>(null)

/** Whether a page form is already open above this point. */
export function useInSettingsForm(): boolean {
  return useContext(FormContext) !== null
}

/** The page form: holds the drafts, draws the Save bar after its children. */
export function SettingsForm({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(
    () => new Map(),
  )
  const [saving, setSaving] = useState(false)

  const register = useCallback((id: string, entry: Entry) => {
    setEntries((m) => new Map(m).set(id, entry))
    return () =>
      setEntries((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
  }, [])
  const form = useMemo(() => ({ register }), [register])

  const count = [...entries.values()].reduce((n, e) => n + e.dirty, 0)

  const save = useCallback(async () => {
    setSaving(true)
    try {
      for (const entry of entries.values()) {
        if (entry.dirty === 0) continue
        try {
          await entry.save()
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not save')
        }
      }
    } finally {
      setSaving(false)
    }
  }, [entries])

  const discard = useCallback(() => {
    for (const entry of entries.values()) entry.discard()
  }, [entries])

  // ⌘↵ saves from anywhere on the page, a field included; a dialog keeps its own.
  useEffect(() => {
    if (count === 0 || saving) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return
      if (e.defaultPrevented) return
      const t = e.target
      if (t instanceof Element && t.closest('[role="dialog"]') !== null) return
      e.preventDefault()
      void save()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [count, saving, save])

  return (
    <FormContext.Provider value={form}>
      {children}
      <SaveBar
        count={count}
        saving={saving}
        onSave={() => void save()}
        onDiscard={discard}
      />
    </FormContext.Provider>
  )
}

/**
 * The Save bar: a strip at the page foot, shown only while a draft is dirty.
 * - It hangs from a zero-height sticky anchor and enters on transform and
 *   opacity only, so nothing on the page moves.
 * - Hidden, it is inert: its buttons take no focus and no click.
 */
function SaveBar({
  count,
  saving,
  onSave,
  onDiscard,
}: {
  count: number
  saving: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  const shown = count > 0
  return (
    <div
      data-save-anchor
      className="pointer-events-none sticky bottom-0 z-sticky mt-auto h-0"
    >
      <div
        role="region"
        aria-label="Unsaved changes"
        aria-hidden={!shown}
        inert={!shown}
        data-save-bar
        data-shown={shown}
        className="absolute inset-x-0 bottom-0 isolate translate-y-full border-t border-hairline bg-paper opacity-0 transition-[transform,opacity] duration-[120ms] ease-out-quart data-[shown=true]:pointer-events-auto data-[shown=true]:translate-y-0 data-[shown=true]:opacity-100 data-[shown=true]:duration-[180ms] motion-reduce:transition-none"
      >
        <div className="box-content flex h-12 max-w-[43.75rem] items-center gap-3 px-8">
          <span className="tabular mono text-micro text-graphite">
            {count} {count === 1 ? 'change' : 'changes'}
          </span>
          <span className="min-w-0 flex-1" />
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={onDiscard}
          >
            Discard
          </Button>
          <Button size="sm" disabled={saving} onClick={onSave}>
            {saving ? 'Saving' : 'Save'}
            <kbd className="mono text-micro opacity-85">⌘↵</kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Same keys, same values. Drafts are flat, so one level is all of it. */
function sameValues(a: DraftValues, b: DraftValues): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
  )
}

type DraftState<T extends DraftValues> = {
  /** The stored values the draft last followed. */
  readonly seen: T
  /** What Discard returns to and what dirty is measured against. */
  readonly baseline: T
  readonly draft: T
}

/**
 * A typed field group's draft, registered with the page's Save bar.
 * - `stored` is what the server holds now. A field the reader has not
 *   touched follows it when the loader re-runs; a touched one keeps its edit.
 * - `commit` writes the draft and may hand back the values to settle on — a
 *   write-only key settles empty. Throw to stay dirty; the bar toasts the
 *   message.
 */
export function useSettingsDraft<T extends DraftValues>(
  stored: T,
  commit: (draft: T) => Promise<T | void>,
): {
  draft: T
  set: <TKey extends keyof T & string>(key: TKey, value: T[TKey]) => void
  dirty: number
} {
  const form = useContext(FormContext)
  const id = useId()
  const [state, setState] = useState<DraftState<T>>(() => ({
    seen: stored,
    baseline: stored,
    draft: stored,
  }))

  // The loader re-ran: untouched fields take the new stored values.
  let current = state
  if (!sameValues(state.seen, stored)) {
    const prev = state
    const draft = Object.keys(stored).reduce<T>(
      (acc, k) =>
        Object.hasOwn(prev.draft, k) && prev.draft[k] !== prev.baseline[k]
          ? { ...acc, [k]: prev.draft[k] }
          : acc,
      stored,
    )
    current = { seen: stored, baseline: stored, draft }
    setState(current)
  }

  const dirty = Object.keys(current.draft).filter(
    (k) => current.draft[k] !== current.baseline[k],
  ).length

  const latest = useRef({ draft: current.draft, commit })
  useEffect(() => {
    latest.current = { draft: current.draft, commit }
  })

  const save = useCallback(async () => {
    const { draft, commit: write } = latest.current
    const settled = (await write(draft)) ?? draft
    setState((s) => ({ ...s, baseline: settled, draft: settled }))
  }, [])

  const discard = useCallback(() => {
    setState((s) => ({ ...s, draft: s.baseline }))
  }, [])

  useEffect(() => {
    if (form === null) return
    return form.register(id, { dirty, save, discard })
  }, [form, id, dirty, save, discard])

  const set = useCallback(
    <TKey extends keyof T & string>(key: TKey, value: T[TKey]) =>
      setState((s) => ({ ...s, draft: { ...s.draft, [key]: value } })),
    [],
  )

  return { draft: current.draft, set, dirty }
}
