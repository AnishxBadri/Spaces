import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { DensityRamp } from '#/components/dither'
import { LedgerRow } from '#/components/ledger-section'
import { MeetingDialog } from '#/components/meeting-dialog'
import { MeetingsLedger } from '#/components/meetings/meetings-ledger'
import { PageHeader } from '#/components/page-header'
import { Tabs } from '#/components/ui/tabs'
import { listMeetings } from '#/lib/server-fns'
import { useClock } from '#/components/clock'
import {
  MEETING_FILTER_LABEL,
  MEETING_FILTERS,
  upcomingHorizon,
} from '#/lib/meetings/list'
import type { MeetingFilter } from '#/lib/meetings/list'
import { modalSearchShape, openModalId } from '#/lib/modal-search'

/**
 * Meetings: what is coming this week and next, by day with Prep, and the
 * past with the meetings nobody wrote up first. A read over meeting
 * interactions; a meeting is an activity, never a record.
 */
export const Route = createFileRoute('/_app/meetings')({
  validateSearch: z.object({
    ...modalSearchShape,
    show: z.enum(MEETING_FILTERS).optional().catch(undefined),
  }),
  component: MeetingsPage,
})

type Loaded = Awaited<ReturnType<typeof listMeetings>>

/**
 * The list, read in the browser so "this week and next" and every time are
 * the reader's clock. `version` re-reads after a write or a retry.
 */
function useMeetingsList(version: number): Loaded | 'failed' | null {
  const [state, setState] = useState<{
    version: number
    list: Loaded | 'failed'
  } | null>(null)
  useEffect(() => {
    let alive = true
    const now = new Date()
    void listMeetings({
      data: {
        now: now.toISOString(),
        until: upcomingHorizon(now).toISOString(),
      },
    })
      .then((list) => {
        if (alive) setState({ version, list })
      })
      .catch(() => {
        // A failed read is not an empty list.
        if (alive) setState({ version, list: 'failed' })
      })
    return () => {
      alive = false
    }
  }, [version])
  if (state === null) return null
  // A retry reads again from the failed state; a refresh keeps the rows.
  if (state.list === 'failed' && state.version !== version) return null
  return state.list
}

function MeetingsPage() {
  const router = useRouter()
  const search = Route.useSearch()
  const go = Route.useNavigate()
  const filter: MeetingFilter = search.show ?? 'all'
  const [version, setVersion] = useState(0)
  const list = useMeetingsList(version)
  const { now } = useClock()

  // The window opens from the URL, so a row and `?modal=meeting&id=` agree.
  const meetingId = openModalId(search, 'meeting')
  const [prepFor, setPrepFor] = useState<string | null>(null)
  const openMeeting = (id: string, prep = false) => {
    setPrepFor(prep ? id : null)
    void go({
      search: (prev) => ({ ...prev, modal: 'meeting', id }),
      resetScroll: false,
    })
  }
  const closeMeeting = () => {
    setPrepFor(null)
    void go({
      search: (prev) => ({ ...prev, modal: undefined, id: undefined }),
      resetScroll: false,
    })
  }
  const choose = (f: MeetingFilter) =>
    void go({
      search: (prev) => ({ ...prev, show: f === 'all' ? undefined : f }),
      resetScroll: false,
    })

  const loaded = list === null || list === 'failed' ? null : list
  // The counts are the server's, over every meeting — not the rows sent.
  const counts = loaded === null ? null : loaded.counts

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Meetings"
        tabs={
          <Tabs
            label="Meetings"
            value={filter}
            onValueChange={choose}
            items={MEETING_FILTERS.map((f) => ({
              id: f,
              label: MEETING_FILTER_LABEL[f],
              ...(counts === null ? {} : { count: counts[f] }),
            }))}
          />
        }
      />
      <div className="flex flex-col px-8 pb-10">
        {list === 'failed' ? (
          <ol>
            <LedgerRow>
              <span
                data-meetings-failed
                className="mono text-micro text-graphite"
              >
                Read failed
              </span>
              <button
                type="button"
                onClick={() => setVersion((v) => v + 1)}
                className="focus-ring mono text-micro text-foreground hover:underline"
              >
                Retry
              </button>
            </LedgerRow>
          </ol>
        ) : loaded === null ? (
          <ol>
            <LedgerRow>
              <DensityRamp width={120} />
            </LedgerRow>
          </ol>
        ) : (
          <MeetingsLedger
            list={loaded}
            filter={filter}
            now={now}
            onOpen={openMeeting}
          />
        )}
      </div>
      <MeetingDialog
        id={meetingId}
        prepOnOpen={prepFor !== null && prepFor === meetingId}
        onOpenChange={(open) => {
          if (!open) closeMeeting()
        }}
        onChanged={() => {
          setVersion((v) => v + 1)
          void router.invalidate()
        }}
      />
    </div>
  )
}
