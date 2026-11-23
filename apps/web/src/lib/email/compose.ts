import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Email } from '#/components/icons'
import { connectHref } from '#/lib/connections/products'
import { composeSearch } from '#/lib/modal-search'
import type { PageAction } from '#/lib/page-actions'
import type {
  DraftDocument,
  DraftFields,
  DraftRecipient,
  EmailDraft,
} from '#/lib/server-fns'

/**
 * The composer's client half: the draft it edits, the mode switch, the
 * autosave debounce and the store the full composer window opens through.
 * Imports types from the barrel and nothing that reaches a database.
 */

/** The draft as the composer holds it: its fields and the id it saves under. */
export type DraftState = DraftFields & { id: string }

/** A new email under `id`: to `to` (a record's prefill), nothing written. */
export function blankDraft(
  id: string,
  to: ReadonlyArray<DraftRecipient> = [],
): DraftState {
  return {
    id,
    mode: 'new',
    inReplyToId: null,
    to: [...to],
    cc: [],
    bcc: [],
    subject: '',
    bodyMd: '',
    attachments: [],
  }
}

/** What applying a template copies into a draft. */
export type TemplateFill = Pick<
  DraftFields,
  'subject' | 'bodyMd' | 'attachments'
>

/** A template applied: its subject, body and files; the recipients stay. */
export function withTemplate(
  draft: DraftState,
  fill: TemplateFill,
): DraftState {
  return {
    ...draft,
    subject: fill.subject,
    bodyMd: fill.bodyMd,
    attachments: fill.attachments,
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

/**
 * What the compose window opens on. A draft held under `draftId` opens as
 * it was; otherwise a new email saves under that id (null mints one), its
 * To from `recordId` and `templateId` applied.
 */
export type ComposeTarget = {
  draftId: string | null
  /** The record it was started on: To's prefill and Attach's files. */
  recordId?: string | null | undefined
  /** A template applied to a new email as it opens. */
  templateId?: string | null | undefined
}

type ComposeState = { compose: ComposeTarget | null }

let state: ComposeState = { compose: null }
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

const CLOSED: ComposeState = { compose: null }

/** A held draft, or a new email, in the composer's own window. */
export function openCompose(target: ComposeTarget) {
  set({ compose: target })
}

export function closeCompose() {
  set(CLOSED)
}

/**
 * Opens a new email's window over this page from its URL (`composeSearch`),
 * a template applied when one is picked. On a record it lands on the
 * Interactions tab, which the window closes back to.
 */
export function useComposeHere(
  tab: 'interactions' | null = null,
): (templateId?: string | null) => void {
  const navigate = useNavigate()
  return (templateId = null) =>
    void navigate({
      to: '.',
      search: (prev) => ({
        ...prev,
        ...(tab === null ? {} : { tab }),
        ...composeSearch(templateId),
      }),
      resetScroll: false,
    })
}

/** Cmd-K's `Email <name>` on a record: the record's own composer. */
export function emailRecordAction(name: string, open: () => void): PageAction {
  return {
    id: 'email',
    label: `Email ${name}`,
    icon: Email,
    words: 'email mail compose write send message new',
    run: open,
  }
}

/**
 * The window's state, mounted once in the app shell. Server and first
 * client render agree: both closed.
 */
export function useComposeState(): ComposeState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => CLOSED,
  )
}

/**
 * The drafts' query key: the sidebar's count under it, and every list that
 * reads a draft (the Email page's Drafts and Threads) under a longer key.
 */
export const EMAIL_DRAFTS_QUERY = 'email-drafts-count'

/**
 * Marks the drafts stale. Every save, send and trash calls it, so the
 * sidebar's count and the Email page's lists follow without a reload.
 */
export function useDraftsChanged(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: [EMAIL_DRAFTS_QUERY] })
  }
}

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

/** Review's choices as the draft holds them: on each To chip. */
export function choicesOf(to: ReadonlyArray<DraftRecipient>): ReviewChoices {
  return {
    fills: Object.fromEntries(
      to.flatMap((r) => (r.fills === undefined ? [] : [[r.email, r.fills]])),
    ),
    accepted: to.filter((r) => r.blank === true).map((r) => r.email),
  }
}

/**
 * The To chips with Review's choices written onto them, so a fill is saved
 * with the draft. Empty fills are not kept.
 */
export function withChoices(
  to: ReadonlyArray<DraftRecipient>,
  choices: ReviewChoices,
): Array<DraftRecipient> {
  return to.map((r) => {
    const chip: DraftRecipient = {
      email: r.email,
      ...(r.entityId === undefined ? {} : { entityId: r.entityId }),
      ...(r.name === undefined ? {} : { name: r.name }),
    }
    const typed = Object.entries(choices.fills[chip.email] ?? {}).flatMap(
      ([path, value]): Array<[string, string]> =>
        value === undefined || value === '' ? [] : [[path, value]],
    )
    return {
      ...chip,
      ...(typed.length === 0 ? {} : { fills: Object.fromEntries(typed) }),
      ...(choices.accepted.includes(chip.email) ? { blank: true } : {}),
    }
  })
}

/**
 * The copies Review shows: one per To recipient when the draft has
 * variables, else none, because one message goes to everyone.
 */
export function reviewCopies<TRow extends { email: string }>(
  rows: ReadonlyArray<TRow>,
  to: ReadonlyArray<DraftRecipient>,
  variables: boolean,
): Array<TRow> {
  if (!variables) return []
  const keys = new Set(to.map((r) => r.email.toLowerCase()))
  return rows.filter((r) => keys.has(r.email.toLowerCase()))
}

/** How many messages a send makes: a copy each, or one to everyone. */
export function messageCount(copies: number): number {
  return Math.max(1, copies)
}

/** The primary in Review: `Send`, or `Send 3 emails`. */
export function sendLabel(messages: number): string {
  return messages === 1 ? 'Send' : `Send ${String(messages)} emails`
}

/**
 * Where a draft is open, for the page Google's consent returns to: the page
 * as it stands (`here`, a URL that already opens it), the record's
 * Interactions tab with the draft's window over it, or the Email page with
 * the window over it (a draft opened from anywhere else).
 */
export type DraftHome = 'here' | 'record' | 'email'

type At = { readonly pathname: string; readonly search: string }

/**
 * The in-app path Reconnect Gmail comes back to: the same page, the same
 * draft open, and `reconnected=gmail`, so it opens on Review with a toast.
 */
export function reconnectReturn(
  home: DraftHome,
  draftId: string,
  at: At,
): string {
  const window = {
    modal: 'email',
    new: '1',
    draft: draftId,
    reconnected: 'gmail',
  }
  if (home === 'email')
    return `/email?${new URLSearchParams(window).toString()}`
  if (home === 'record') {
    const query = new URLSearchParams({ tab: 'interactions', ...window })
    return `${at.pathname}?${query.toString()}`
  }
  const query = new URLSearchParams(at.search)
  query.set('reconnected', 'gmail')
  return `${at.pathname}?${query.toString()}`
}

/**
 * Whether `draftId` was just reopened by Reconnect Gmail's return. Seen
 * once: it says `Gmail reconnected` and drops the key from the URL, and the
 * answer holds for that draft so a composer that mounts later still opens
 * on Review.
 */
export function useReconnectedLanding(draftId: string | null): boolean {
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const [landed, setLanded] = useState<string | null>(null)
  const back = draftId !== null && search.reconnected === 'gmail'
  useEffect(() => {
    if (!back) return
    setLanded(draftId)
    toast('Gmail reconnected')
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, reconnected: undefined }),
      replace: true,
      resetScroll: false,
    })
  }, [back, draftId, navigate])
  return draftId !== null && (back || landed === draftId)
}

/** Google's consent for the sending mailbox, back to the draft open. */
export function reconnectHref(
  account: string,
  home: DraftHome,
  draftId: string,
  at: At,
): string {
  return connectHref(
    'google',
    'gmail',
    [],
    reconnectReturn(home, draftId, at),
    account,
  )
}

/** The blanks still open across the copies; Send stays off until none is. */
export function openBlankCount(
  copies: ReadonlyArray<{ email: string; blanks: ReadonlyArray<string> }>,
  choices: ReviewChoices,
): number {
  return copies.reduce((sum, r) => sum + openBlanks(r, choices).length, 0)
}
