import { useEffect, useRef, useSyncExternalStore } from 'react'
import type {
  DraftDocument,
  DraftFields,
  DraftRecipient,
  EmailDraft,
} from '#/lib/server-fns'

/**
 * The composer's client half: the draft it edits, the mode switch, the
 * autosave debounce and the store the account menu opens Drafts through.
 * Imports types from the barrel and nothing that reaches a database.
 */

/** The draft as the composer holds it: its fields and the id it saves under. */
export type DraftState = DraftFields & { id: string }

/** A new email: nobody, nothing, a fresh id. */
export function blankDraft(id: string): DraftState {
  return {
    id,
    mode: 'new',
    inReplyToId: null,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    bodyMd: '',
    attachments: [],
  }
}

export function draftStateOf(draft: EmailDraft): DraftState {
  return {
    id: draft.id,
    mode: draft.mode,
    inReplyToId: draft.inReplyToId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyMd: draft.bodyMd,
    attachments: draft.attachments,
  }
}

/** What the autosave sends: attachments by id only. */
export function saveInput(draft: DraftState) {
  return {
    ...draft,
    attachments: draft.attachments.map((a) => ({ documentId: a.documentId })),
  }
}

const withoutSuffix = (text: string, suffix: string) =>
  suffix !== '' && text.endsWith(suffix)
    ? text.slice(0, -suffix.length).trimEnd()
    : text

const sameDoc = (a: DraftDocument) => (b: DraftDocument) =>
  a.documentId === b.documentId

/**
 * Reply → reply all → forward keeps what was written: the body's own text,
 * a subject typed over, files added by hand and the Bcc. The recipients,
 * the quoted block and the parent's files are the new mode's.
 */
export function switchMode(
  draft: DraftState,
  from: DraftFields,
  to: DraftFields,
): DraftState {
  const written = withoutSuffix(draft.bodyMd, from.bodyMd)
  const added = draft.attachments.filter(
    (a) => !from.attachments.some(sameDoc(a)),
  )
  return {
    ...draft,
    mode: to.mode,
    to: to.to,
    cc: to.cc,
    subject: draft.subject === from.subject ? to.subject : draft.subject,
    bodyMd:
      to.bodyMd === ''
        ? written
        : written === ''
          ? `\n\n${to.bodyMd}`
          : `${written}\n\n${to.bodyMd}`,
    attachments: [
      ...to.attachments,
      ...added.filter((a) => !to.attachments.some(sameDoc(a))),
    ],
  }
}

/** Every address the draft is going to, Bcc included. */
export function recipientCount(draft: DraftState): number {
  return draft.to.length + draft.cc.length + draft.bcc.length
}

/** `alias` added to a line, unless the line already holds it. */
export function addRecipient(
  line: ReadonlyArray<DraftRecipient>,
  chip: DraftRecipient,
): Array<DraftRecipient> {
  const key = chip.email.toLowerCase()
  return line.some((r) => r.email.toLowerCase() === key)
    ? [...line]
    : [...line, chip]
}

/** A typed address the chips accept as a new one: one `@`, a dotted domain. */
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(text.trim())
}

/** The debounce, from the last keystroke to the save. */
export const AUTOSAVE_MS = 800

/**
 * Saves `value` once it has stood still for `delay`, never per keystroke.
 * - Nothing is saved until `dirty`: opening a draft writes no row.
 * - Unmounting with a change pending saves it then, so a closed composer
 *   reopens with what was typed.
 * - `flush` saves a pending change now (Cancel); `cancel` drops it (Trash).
 */
export function useDraftAutosave<T>(
  value: T,
  dirty: boolean,
  save: (value: T) => Promise<void>,
  delay: number = AUTOSAVE_MS,
): { flush: () => Promise<void>; cancel: () => void } {
  const latest = useRef(value)
  latest.current = value
  const saver = useRef(save)
  saver.current = save
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stop = () => {
    if (timer.current === null) return false
    clearTimeout(timer.current)
    timer.current = null
    return true
  }

  useEffect(() => {
    if (!dirty) return
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void saver.current(latest.current)
    }, delay)
  }, [value, dirty, delay])

  useEffect(
    () => () => {
      if (stop()) void saver.current(latest.current)
    },
    [],
  )

  const handles = useRef({
    flush: async () => {
      if (stop()) await saver.current(latest.current)
    },
    cancel: () => {
      stop()
    },
  })
  return handles.current
}

/** Which compose window is open, if any: a held draft, or a new email. */
export type ComposeTarget = { draftId: string } | { draftId: null }

type ComposeState = { drafts: boolean; compose: ComposeTarget | null }

let state: ComposeState = { drafts: false, compose: null }
const listeners = new Set<() => void>()

function set(next: ComposeState) {
  state = next
  for (const l of listeners) l()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

const CLOSED: ComposeState = { drafts: false, compose: null }

/** The account menu's door: the drafts list. */
export function openDrafts() {
  set({ drafts: true, compose: null })
}

/** A draft from the list, or a new email; the list closes behind it. */
export function openCompose(target: ComposeTarget) {
  set({ drafts: false, compose: target })
}

export function closeCompose() {
  set(CLOSED)
}

/**
 * The windows' state, mounted once in the app shell. Server and first
 * client render agree: both closed.
 */
export function useComposeState(): ComposeState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => CLOSED,
  )
}

/** The account menu's query key for the drafts count. */
export const EMAIL_DRAFTS_QUERY = 'email-drafts-count'

/** What Review holds per recipient: the blanks typed in, and a blank accepted. */
export type ReviewChoices = {
  fills: Readonly<Partial<Record<string, Partial<Record<string, string>>>>>
  /** Recipients whose remaining blanks go out empty. */
  accepted: ReadonlyArray<string>
}

export const NO_CHOICES: ReviewChoices = { fills: {}, accepted: [] }

/** The blanks in `row` not yet filled, unless the row's blanks are accepted. */
export function openBlanks(
  row: { email: string; blanks: ReadonlyArray<string> },
  choices: ReviewChoices,
): Array<string> {
  if (choices.accepted.includes(row.email)) return []
  const filled = choices.fills[row.email] ?? {}
  return row.blanks.filter((p) => (filled[p] ?? '').trim() === '')
}
