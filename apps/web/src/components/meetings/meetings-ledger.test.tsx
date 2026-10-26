import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ListedMeeting, SetupAudience } from '#/lib/server-fns'
import type { MeetingFilter } from '#/lib/meetings/list'
import { MeetingsLedger } from './meetings-ledger'

/**
 * The Meetings page's list: upcoming under day heads with their start and
 * Prep, the past with `■ No write-up` and Write on what nobody wrote up and
 * the write-up state on the rest, a cancelled meeting struck in place, the
 * `n earlier` foot, and each filter narrowing it.
 */

const ADMIN: SetupAudience = { isAdmin: true, admins: ['Anish'] }

let n = 0
const aMeeting = (over: Partial<ListedMeeting>): ListedMeeting => ({
  id: `00000000-0000-4000-8000-00000000000${++n}`,
  title: 'Call',
  startsAt: new Date(2026, 9, 13, 9, 30).toISOString(),
  endsAt: new Date(2026, 9, 13, 10, 0).toISOString(),
  cancelled: false,
  participants: [],
  records: [],
  artifacts: [],
  noteId: null,
  mine: false,
  myRsvp: null,
  writeUp: 'none',
  via: null,
  tasks: 0,
  ...over,
})

const UPCOMING = [
  aMeeting({
    title: 'Flent founder call',
    startsAt: new Date(2026, 9, 13, 9, 30).toISOString(),
    endsAt: new Date(2026, 9, 13, 10, 0).toISOString(),
    participants: [
      { email: 'ana@flent.io', name: 'Ana Reyes', rsvp: 'accepted' },
    ],
    records: [{ id: 'c1', kind: 'company', name: 'Flent', objectSlug: null }],
    mine: true,
    myRsvp: 'tentative',
  }),
  aMeeting({
    title: 'Northgate founder call',
    startsAt: new Date(2026, 9, 13, 15, 0).toISOString(),
    endsAt: new Date(2026, 9, 13, 15, 30).toISOString(),
  }),
  aMeeting({
    title: 'Kestrel intro',
    startsAt: new Date(2026, 9, 15, 11, 0).toISOString(),
    endsAt: new Date(2026, 9, 15, 11, 30).toISOString(),
  }),
]

const PAST = [
  aMeeting({
    title: 'Unwritten call',
    startsAt: new Date(2026, 9, 9, 10, 0).toISOString(),
  }),
  aMeeting({
    title: 'Granola call',
    startsAt: new Date(2026, 9, 11, 10, 0).toISOString(),
    writeUp: 'written',
    noteId: 'n1',
    via: 'Granola',
    mine: true,
    tasks: 2,
  }),
  aMeeting({
    title: 'Dropped call',
    startsAt: new Date(2026, 9, 10, 10, 0).toISOString(),
    cancelled: true,
  }),
]

async function render(
  filter: MeetingFilter,
  over: Partial<{
    upcoming: Array<ListedMeeting>
    past: Array<ListedMeeting>
    calendar: boolean
    earlier: number
  }> = {},
) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <MeetingsLedger
          list={{
            upcoming: over.upcoming ?? UPCOMING,
            past: over.past ?? PAST,
            earlier: over.earlier ?? 0,
            counts: { all: 0, upcoming: 0, past: 0, unwritten: 0, mine: 0 },
            calendar: over.calendar ?? true,
            audience: ADMIN,
          }}
          filter={filter}
          now={new Date(2026, 9, 13, 8, 0).toISOString()}
          onOpen={() => {}}
        />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/meetings'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

const count = (html: string, needle: string) => html.split(needle).length - 1

describe('MeetingsLedger', () => {
  it('groups upcoming under day heads, each row its start, attendees and Prep, then the past', async () => {
    const html = await render('all')
    expect(html).toContain('TODAY · TUE 13 OCT')
    expect(html).toContain('>THU 15 OCT<')
    expect(html).not.toContain('TOMORROW')
    expect(html.indexOf('Flent founder call')).toBeLessThan(
      html.indexOf('Northgate founder call'),
    )
    expect(html.indexOf('THU 15 OCT')).toBeLessThan(html.indexOf('>PAST<'))
    expect(count(html, '>Prep<')).toBe(3)
    // The start, not the span; the attendee with their mark.
    expect(html).toContain('>09:30<')
    expect(html).not.toContain('09:30–10:00')
    expect(html).toMatch(/Ana Reyes <span[^>]*>✓</)
  })

  it('carries ■ No write-up and Write on the unwritten past row only, the write-up and its tasks on the rest, and strikes a cancelled one in place', async () => {
    const html = await render('past')
    expect(count(html, '>Write<')).toBe(1)
    expect(html).toContain('>■ No write-up<')
    expect(html).toMatch(/text-warning[^>]*>■/)
    // The recorder's mark, then the write-up and the tasks it proposed.
    expect(html).toMatch(/title="Granola".*>G<\/span>.*Write-up · 2 tasks/)
    expect(html).toContain('>Cancelled<')
    expect(html).toMatch(/line-through[^>]*>Dropped call</)
    expect(html.indexOf('Granola call')).toBeLessThan(
      html.indexOf('Dropped call'),
    )
    expect(html).not.toContain('>Prep<')
  })

  it('ends the past on what the cut left out', async () => {
    expect(await render('all', { earlier: 8 })).toContain('>8 earlier<')
    expect(await render('all')).not.toContain('earlier<')
    expect(await render('upcoming', { earlier: 8 })).not.toContain('earlier<')
  })

  it('narrows to what each filter names', async () => {
    const upcoming = await render('upcoming')
    expect(upcoming).not.toContain('>Past<')
    expect(count(upcoming, 'data-meeting-row')).toBe(3)

    const unwritten = await render('unwritten')
    expect(count(unwritten, 'data-meeting-row')).toBe(1)
    expect(unwritten).toContain('Unwritten call')

    const mine = await render('mine')
    expect(count(mine, 'data-meeting-row')).toBe(2)
    expect(mine).toContain('Flent founder call')
    expect(mine).toContain('Granola call')
  })

  it('rows are 40px ledger rows', async () => {
    const html = await render('all')
    expect(count(html, 'h-ledger-row')).toBe(UPCOMING.length + PAST.length)
  })

  it('says so when a filter is empty, and names the missing calendar when nothing is there', async () => {
    expect(await render('unwritten', { past: [] })).toContain(
      'Every meeting is written up.',
    )
    const none = await render('all', {
      upcoming: [],
      past: [],
      calendar: false,
    })
    expect(none).toContain('No calendar connected')
    expect(none).toContain('Connect Google')
  })
})
