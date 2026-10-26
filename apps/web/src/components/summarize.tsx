import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  getEntitySensitivity,
  isLaneRouted,
  summarize,
  summarizeStatus,
} from '#/lib/server-fns'

/**
 * Summarize — the control on a Files-tab row (a document), shaped like Read
 * deck (`useDeckReader`).
 * - The gate is asked once per record: the synthesize lane routed, a live
 *   credential, and a local model when the record resolves sensitive.
 * - The run is a polled worker job ending in a toast: the suggestion is in
 *   Review, or the job's own sentence ("Nothing to summarize: …").
 */

type Status = Awaited<ReturnType<typeof summarizeStatus>>[string]

/** What a control needs to draw; null when it gets no button. */
export type Summarizer = { summarizing: boolean; onSummarize: () => void }

const stateOf = (
  statuses: Record<string, Status>,
  id: string,
): Status['state'] =>
  Object.hasOwn(statuses, id) ? statuses[id].state : 'idle'

/**
 * One record's summaries. `sourceIds` are what this surface offers — the
 * documents on a Files tab, or the record itself — and the returned function
 * answers per source: a document id, or the record's own id for the record.
 */
export function useSummarizer(
  recordId: string,
  sourceIds: ReadonlyArray<string>,
): (sourceId: string) => Summarizer | null {
  const [routed, setRouted] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, Status>>({})
  const [pressed, setPressed] = useState<Array<string>>([])
  const previous = useRef<Record<string, Status>>({})
  const sourceKey = sourceIds.join(',')

  useEffect(() => {
    const live = { current: true }
    void (async () => {
      try {
        const [lane, sensitivity] = await Promise.all([
          isLaneRouted({ data: { lane: 'synthesize' } }),
          getEntitySensitivity({ data: { entityId: recordId } }),
        ])
        if (live.current) setRouted(lane[sensitivity.sensitivity])
      } catch {
        // A gate that cannot tell is closed: no button rather than a toast.
        if (live.current) setRouted(false)
      }
    })()
    return () => {
      live.current = false
    }
  }, [recordId])

  const refresh = useCallback(async () => {
    const ids = sourceKey === '' ? [] : sourceKey.split(',')
    if (ids.length === 0) return
    const next = await summarizeStatus({ data: { recordId, sourceIds: ids } })
    for (const [id, status] of Object.entries(next)) {
      if (stateOf(previous.current, id) !== 'summarizing') continue
      if (status.state === 'failed') toast.error(status.message)
      if (status.state === 'done')
        toast.success('Summary drafted · the note is in Review')
    }
    previous.current = next
    setStatuses(next)
    setPressed((p) => p.filter((id) => stateOf(next, id) === 'summarizing'))
  }, [recordId, sourceKey])

  useEffect(() => {
    if (!routed) return
    void refresh().catch(() => undefined)
  }, [routed, refresh])

  const anyRunning =
    pressed.length > 0 ||
    Object.values(statuses).some((s) => s.state === 'summarizing')

  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [anyRunning, refresh])

  async function start(sourceId: string) {
    setPressed((p) => [...p, sourceId])
    previous.current = {
      ...previous.current,
      [sourceId]: { state: 'summarizing' },
    }
    try {
      const result = await summarize({
        data: {
          recordId,
          documentId: sourceId === recordId ? null : sourceId,
        },
      })
      if (result.status === 'already-summarizing')
        toast.message('Already summarizing')
      if (result.status === 'queue-unavailable') {
        toast.error('The worker queue is unreachable; try again shortly')
        setPressed((p) => p.filter((id) => id !== sourceId))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not summarize')
      setPressed((p) => p.filter((id) => id !== sourceId))
    }
  }

  return (sourceId) => {
    if (!routed) return null
    return {
      summarizing:
        pressed.includes(sourceId) ||
        stateOf(statuses, sourceId) === 'summarizing',
      onSummarize: () => void start(sourceId),
    }
  }
}
