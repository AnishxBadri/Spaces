import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import {
  extractKeyTerms,
  getEntitySensitivity,
  isLaneRouted,
  keyTermsStatus,
} from '#/lib/server-fns'
import type { listRecordDocuments } from '#/lib/server-fns'
import { offersKeyTerms } from '#/lib/documents/key-terms-gate'

/**
 * Extract key terms (SPA-91) — the Files-tab row's control, a copy of Read
 * deck (`record-files.tsx`, `useDeckReader`): the gate is asked once per tab
 * — the extract lane routed, with a live credential, and to a local model
 * when the record resolves sensitive — and a row shows the button only when
 * `offersKeyTerms` says so: a `legal` or `dd` document, its text extracted,
 * filed on a deal. The read is a worker job, polled while it runs, whose end
 * is a toast: the note is in the inbox, or the job's own sentence.
 */

type Documents = Awaited<ReturnType<typeof listRecordDocuments>>

type Status = Awaited<ReturnType<typeof keyTermsStatus>>[string]

/** What a row needs to draw the control; null when it gets none. */
export type KeyTermsExtractor = { extracting: boolean; onExtract: () => void }

const stateOf = (
  statuses: Record<string, Status>,
  id: string,
): Status['state'] =>
  Object.hasOwn(statuses, id) ? statuses[id].state : 'idle'

export function useKeyTermsExtractor(
  entityId: string,
  documents: Documents,
): (doc: Documents[number]) => KeyTermsExtractor | null {
  const [routed, setRouted] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, Status>>({})
  const [pressed, setPressed] = useState<Array<string>>([])
  const previous = useRef<Record<string, Status>>({})

  const docKey = documents
    .filter((d) => offersKeyTerms(d, true))
    .map((d) => d.id)
    .join(',')

  useEffect(() => {
    const live = { current: true }
    void (async () => {
      try {
        const [lane, sensitivity] = await Promise.all([
          isLaneRouted({ data: { lane: 'extract' } }),
          getEntitySensitivity({ data: { entityId } }),
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
  }, [entityId])

  const refresh = useCallback(async () => {
    const ids = docKey === '' ? [] : docKey.split(',')
    if (ids.length === 0) return
    const next = await keyTermsStatus({ data: { documentIds: ids } })
    for (const [id, status] of Object.entries(next)) {
      if (stateOf(previous.current, id) !== 'extracting') continue
      if (status.state === 'failed') toast.error(status.message)
      if (status.state === 'done')
        toast.success('Key terms read · the note is in the inbox')
    }
    previous.current = next
    setStatuses(next)
    setPressed((p) => p.filter((id) => stateOf(next, id) === 'extracting'))
  }, [docKey])

  useEffect(() => {
    if (!routed) return
    void refresh().catch(() => undefined)
  }, [routed, refresh])

  const anyRunning =
    pressed.length > 0 ||
    Object.values(statuses).some((s) => s.state === 'extracting')

  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [anyRunning, refresh])

  async function start(documentId: string) {
    setPressed((p) => [...p, documentId])
    previous.current = {
      ...previous.current,
      [documentId]: { state: 'extracting' },
    }
    try {
      const result = await extractKeyTerms({ data: { documentId } })
      if (result.status === 'already-extracting')
        toast.message('Already extracting')
      if (result.status === 'queue-unavailable') {
        toast.error('The worker queue is unreachable; try again shortly')
        setPressed((p) => p.filter((id) => id !== documentId))
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not extract the key terms',
      )
      setPressed((p) => p.filter((id) => id !== documentId))
    }
  }

  return (doc) => {
    if (!offersKeyTerms(doc, routed)) return null
    return {
      extracting:
        pressed.includes(doc.id) || stateOf(statuses, doc.id) === 'extracting',
      onExtract: () => void start(doc.id),
    }
  }
}

/** The Files-tab row's control: small, beside Read deck and Summarize. */
export function KeyTermsRowButton({
  extractor,
}: {
  extractor: KeyTermsExtractor
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={extractor.extracting}
      onClick={extractor.onExtract}
      title="Read the deal’s terms into a note, as a suggestion"
      className="mr-1"
    >
      {extractor.extracting ? 'extracting…' : 'Extract key terms'}
    </Button>
  )
}
