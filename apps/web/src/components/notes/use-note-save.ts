import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteBody } from '@spaces/db/schema/kinds'
import {
  deriveMarkdown,
  extractMentionIds,
} from '#/components/editor/note-editor'
import { saveNote } from '#/lib/server-fns'
import type { SaveState } from './note-head'

/** What the editor hands over on each change; read only when a save runs. */
export type NoteSnapshot = {
  document: NoteBody
  blocksToMarkdownLossy: () => Promise<string>
}

/** Quiet time after the last keystroke before a save runs. */
export const SAVE_DEBOUNCE_MS = 800
/** The wait before a failed save tries once more by itself. */
export const SAVE_RETRY_MS = 2000

/**
 * A note's autosave: the title and body debounce into one `saveNote`, and
 * the head's save word reads `state`.
 * - Every save sends the latest title and body, and saves run one at a time,
 *   so a slow save landing late never puts older text over newer.
 * - A failed save tries once more after `SAVE_RETRY_MS`; if that fails too
 *   the state stays `failed` until `retry()` or the next edit lands one. A
 *   new edit earns a fresh automatic retry.
 * - `hasPending()` is true from an edit until a save of it lands: dirty,
 *   saving or failed. It reads refs, so a blocker can call it at any time.
 * - `flushNow()` runs the pending save at once and resolves to whether
 *   everything typed has landed.
 */
export function useNoteSave({
  noteId,
  initialTitle,
}: {
  noteId: string
  initialTitle: string
}) {
  const [state, setState] = useState<SaveState>('idle')

  const snapshot = useRef<NoteSnapshot | null>(null)
  const title = useRef(initialTitle)
  // An edit bumps `version`; a save that lands records the version it sent.
  const version = useRef(0)
  const landed = useRef(0)
  const inflight = useRef<Promise<boolean> | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Whether the current edit has spent its one automatic retry.
  const retried = useRef(false)
  const alive = useRef(true)

  const clearTimers = useCallback(() => {
    if (debounce.current !== null) clearTimeout(debounce.current)
    if (retryTimer.current !== null) clearTimeout(retryTimer.current)
    debounce.current = null
    retryTimer.current = null
  }, [])

  const saveOnce = useCallback(
    async (sent: number): Promise<boolean> => {
      try {
        // No editor change yet → title-only save; the body stays untouched.
        let body
        const snap = snapshot.current
        if (snap) {
          const lossyMd = await snap.blocksToMarkdownLossy()
          body = {
            bodyJson: snap.document,
            bodyMd: deriveMarkdown(lossyMd, snap.document),
            mentionIds: extractMentionIds(snap.document),
          }
        }
        await saveNote({ data: { id: noteId, title: title.current, body } })
        landed.current = Math.max(landed.current, sent)
        return true
      } catch {
        return false
      }
    },
    [noteId],
  )

  const flush = useCallback(async (): Promise<boolean> => {
    // One save at a time: wait out the one in flight, then send what is
    // newest now rather than what was newest when this call began.
    while (inflight.current !== null) await inflight.current
    if (landed.current === version.current) return true
    const sent = version.current
    setState('saving')
    const run = saveOnce(sent)
    inflight.current = run
    const ok = await run
    inflight.current = null
    // A newer edit has its own debounce running and owns the word.
    if (!alive.current || version.current !== sent) return ok
    if (ok) {
      setState('saved')
      return true
    }
    setState('failed')
    if (!retried.current) {
      retried.current = true
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null
        void flush()
      }, SAVE_RETRY_MS)
    }
    return false
  }, [saveOnce])

  const schedule = useCallback(() => {
    version.current += 1
    retried.current = false
    clearTimers()
    setState('dirty')
    debounce.current = setTimeout(() => {
      debounce.current = null
      void flush()
    }, SAVE_DEBOUNCE_MS)
  }, [clearTimers, flush])

  const edit = useCallback(
    (next: NoteSnapshot) => {
      snapshot.current = next
      schedule()
    },
    [schedule],
  )

  const editTitle = useCallback(
    (next: string) => {
      title.current = next
      schedule()
    },
    [schedule],
  )

  /** The word's `Retry`: save now, without spending a new automatic retry. */
  const retry = useCallback(() => {
    clearTimers()
    void flush()
  }, [clearTimers, flush])

  const flushNow = useCallback(() => {
    clearTimers()
    return flush()
  }, [clearTimers, flush])

  const hasPending = useCallback(() => landed.current !== version.current, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimers()
    }
  }, [clearTimers])

  return {
    state,
    pending: state === 'dirty' || state === 'saving' || state === 'failed',
    hasPending,
    edit,
    editTitle,
    retry,
    flushNow,
  }
}
