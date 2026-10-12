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
 * The Meetings page's list (D68 amended): upcoming under day heads with
 * Prep, the past with Write on what nobody wrote up and the write-up state
 * on the rest, a cancelled meeting struck in place, and each filter
 * narrowing it.
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
  }> = {},
) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <MeetingsLedger
          list={{
            upcoming: over.upcoming ?? UPCOMING,
            past: over.past ?? PAST,
            more: false,
            calendar: over.calendar ?? true,
            audience: ADMIN,
          }}
          filter={filter}
          today="2026-10-13"
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
  it('groups upcoming under day heads, each row with Prep, then the past', async () => {
    const html = await render('all')
    expect(html).toContain('Today · Tue 10-13')
    expect(html).toContain('Thu 10-15')
    expect(html.indexOf('Flent founder call')).toBeLessThan(
      html.indexOf('Northgate founder call'),
    )
    expect(html.indexOf('Thu 10-15')).toBeLessThan(html.indexOf('>Past<'))
    expect(count(html, '>Prep<')).toBe(3)
    // The reader's own answer is the upcoming row's lane.
    expect(html).toContain('>maybe<')
  })

  it('carries Write on the unwritten past row only, the state word on the rest, and strikes a cancelled one in place', async () => {
    const html = await render('past')
    expect(count(html, '>Write<')).toBe(1)
    expect(html).toContain('>no write-up<')
    expect(html).toContain('>via Granola<')
    expect(html).toContain('>cancelled<')
    expect(html).toMatch(/line-through[^>]*>Dropped call</)
    expect(html.indexOf('Granola call')).toBeLessThan(
      html.indexOf('Dropped call'),
    )
    expect(html).not.toContain('>Prep<')
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
