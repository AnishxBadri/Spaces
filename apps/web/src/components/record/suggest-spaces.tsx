import { useRouter } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  isLaneRouted,
  suggestSpaces,
  suggestSpacesStatus,
} from '#/lib/server-fns'
import type { SuggestSpacesStatus } from '#/lib/server-fns'

/**
 * "Suggest spaces" (SPA-103) — the Spaces rail's one AI verb. Pressing it
 * enqueues one classify run for this record; the run proposes a `space_tag`
 * suggestion per space it places the record in, and those land in /inbox
 * and on this rail's "Waiting" chips (SPA-114) — this control draws no
 * pending state of its own beyond its label.
 *
 * **Absent while the classify lane is unrouted** — kind classify's rule
 * (SPA-62). The gate is the lane routed at either scope, not at this
 * record's resolved sensitivity: a record under a sensitive space on a
 * cloud-routed lane still sees the action, and pressing it is refused with
 * a toast naming the space, which is how a person learns why. The run is a
 * worker job, polled while it runs, as Read deck and Summarize are; when it
 * settles the rail reloads, so the Waiting chip appears in place.
 */
export function SuggestSpacesAction({ entityId }: { entityId: string }) {
  const router = useRouter()
  const [routed, setRouted] = useState(false)
  const [running, setRunning] = useState(false)
  const pressed = useRef(false)

  useEffect(() => {
    const live = { current: true }
    void (async () => {
      try {
        const lane = await isLaneRouted({ data: { lane: 'classify' } })
        if (live.current) setRouted(lane.normal || lane.sensitive)
      } catch {
        // A gate that cannot tell is closed: no action rather than a toast.
        if (live.current) setRouted(false)
      }
    })()
    return () => {
      live.current = false
    }
  }, [entityId])

  const settle = useCallback(
    (status: SuggestSpacesStatus) => {
      if (status.state === 'running') {
        // Watched from here on, whoever pressed it: its end reloads the rail.
        pressed.current = true
        setRunning(true)
        return
      }
      setRunning(false)
      if (!pressed.current) return
      pressed.current = false
      if (status.state === 'failed') toast.error(status.message)
      if (status.state === 'done') {
        if (status.proposed === 0)
          toast.message('No new space to suggest for this record')
        else
          toast.success(
            `${String(status.proposed)} space${status.proposed === 1 ? '' : 's'} suggested · review in the inbox`,
          )
        void router.invalidate()
      }
    },
    [router],
  )

  const refresh = useCallback(async () => {
    settle(await suggestSpacesStatus({ data: { entityId } }))
  }, [entityId, settle])

  useEffect(() => {
    if (!routed) return
    void refresh().catch(() => undefined)
  }, [routed, refresh])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [running, refresh])

  async function press() {
    pressed.current = true
    setRunning(true)
    try {
      const result = await suggestSpaces({ data: { entityId } })
      if (result.status === 'queued') return
      pressed.current = result.status === 'already-running'
      setRunning(result.status === 'already-running')
      if (result.status === 'already-running')
        toast.message('Already suggesting spaces')
      if (result.status === 'queue-unavailable')
        toast.error('The worker queue is unreachable; try again shortly')
      if (result.status === 'refused') toast.error(result.message)
    } catch (err) {
      pressed.current = false
      setRunning(false)
      toast.error(
        err instanceof Error ? err.message : 'Could not suggest spaces',
      )
    }
  }

  if (!routed) return null
  return (
    <button
      type="button"
      disabled={running}
      onClick={() => void press()}
      title="Ask the classify lane which spaces this record belongs in; each lands in the inbox as a suggestion"
      className="focus-ring mt-1 flex h-7 items-center gap-1.5 text-label text-graphite hover:text-foreground disabled:opacity-60"
    >
      <Sparkles className="size-3" strokeWidth={1.75} aria-hidden />
      {running ? 'Suggesting spaces…' : 'Suggest spaces'}
    </button>
  )
}
