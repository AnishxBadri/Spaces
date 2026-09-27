import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import {
  getEntitySensitivity,
  isLaneRouted,
  readWithVision,
  visionStatus,
} from '#/lib/server-fns'
import type { listRecordDocuments } from '#/lib/server-fns'
import { offersVision } from '#/lib/documents/vision-gate'

/**
 * Read with vision (SPA-94) — the Files-tab row's control, a copy of Read
 * deck (`record-files.tsx`, `useDeckReader`) and Extract key terms
 * (`./key-terms.tsx`). The gate is asked once per tab — the vision lane
 * routed, with a live credential, and to a local model when the record
 * resolves sensitive — and a row shows the button only when `offersVision`
 * says so: a stored PDF at `unsupported`, never one at `failed`. The read
 * is a worker job, polled while it runs; when it settles the rows reload,
 * so a success shows the text's snippet and a failure the provider's
 * sentence where "no text layer" was.
 */

type Documents = Awaited<ReturnType<typeof listRecordDocuments>>

type Status = Awaited<ReturnType<typeof visionStatus>>[string]

/** What a row needs to draw the control; null when it gets none. */
export type VisionReader = { reading: boolean; onRead: () => void }

const stateOf = (
  statuses: Record<string, Status>,
  id: string,
): Status['state'] =>
  Object.hasOwn(statuses, id) ? statuses[id].state : 'idle'

export function useVisionReader(
  entityId: string,
  documents: Documents,
): (doc: Documents[number]) => VisionReader | null {
  const router = useRouter()
  const [routed, setRouted] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, Status>>({})
  const [pressed, setPressed] = useState<Array<string>>([])
  const previous = useRef<Record<string, Status>>({})

  const docKey = documents
    .filter((d) => offersVision(d, true))
    .map((d) => d.id)
    .join(',')

  useEffect(() => {
    const live = { current: true }
    void (async () => {
      try {
        const [lane, sensitivity] = await Promise.all([
          isLaneRouted({ data: { lane: 'vision' } }),
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
    const next = await visionStatus({ data: { documentIds: ids } })
    let settled = false
    for (const [id, status] of Object.entries(next)) {
      if (stateOf(previous.current, id) !== 'reading') continue
      if (status.state === 'failed') {
        toast.error(status.message)
        settled = true
      }
      if (status.state === 'done') {
        toast.success('Read with vision · the text is searchable')
        settled = true
      }
    }
    previous.current = next
    setStatuses(next)
    setPressed((p) => p.filter((id) => stateOf(next, id) === 'reading'))
    // The job wrote the row — its text, or its extraction_error — so the
    // rows are read again rather than guessed at here.
    if (settled) void router.invalidate()
  }, [docKey, router])

  useEffect(() => {
    if (!routed) return
    void refresh().catch(() => undefined)
  }, [routed, refresh])

  const anyReading =
    pressed.length > 0 ||
    Object.values(statuses).some((s) => s.state === 'reading')

  useEffect(() => {
    if (!anyReading) return
    const timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [anyReading, refresh])

  async function read(documentId: string) {
    setPressed((p) => [...p, documentId])
    previous.current = {
      ...previous.current,
      [documentId]: { state: 'reading' },
    }
    try {
      const result = await readWithVision({ data: { documentId } })
      if (result.status === 'already-reading') toast.message('Already reading')
      if (result.status === 'queue-unavailable') {
        toast.error('The worker queue is unreachable; try again shortly')
        setPressed((p) => p.filter((id) => id !== documentId))
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not read with vision',
      )
      setPressed((p) => p.filter((id) => id !== documentId))
    }
  }

  return (doc) => {
    if (!offersVision(doc, routed)) return null
    return {
      reading:
        pressed.includes(doc.id) || stateOf(statuses, doc.id) === 'reading',
      onRead: () => void read(doc.id),
    }
  }
}

/** The Files-tab row's control: small, where Read deck sits on a deck. */
export function VisionRowButton({ reader }: { reader: VisionReader }) {
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={reader.reading}
      onClick={reader.onRead}
      title="Send the scanned pages to the vision model and store their text"
      className="mr-1"
    >
      {reader.reading ? 'reading…' : 'Read with vision'}
    </Button>
  )
}
