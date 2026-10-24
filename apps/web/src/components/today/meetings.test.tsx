import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DayMeeting, SetupAudience } from '#/lib/server-fns'
import { MeetingsSection } from './meetings'

/**
 * Today's Meetings section: the head carries the day's count once,
 * `‹ today ›` and "all meetings ›"; a row prints the time, the title, each
 * participant with the RSVP mark and never a control to change it, the
 * linked records and the artifact marks; with no calendar the section is one
 * line, which names an admin for a member.
 */

const ADMIN: SetupAudience = { isAdmin: true, admins: ['Anish'] }

const MEETINGS: Array<DayMeeting> = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Flent intro',
    startsAt: '2026-10-13T09:30:00.000Z',
    endsAt: '2026-10-13T10:00:00.000Z',
    cancelled: false,
    participants: [
      { email: 'ana@flent.io', name: 'Ana Reyes', rsvp: 'accepted' },
      { email: 'ben@flent.io', name: null, rsvp: 'declined' },
    ],
    records: [{ id: 'c1', kind: 'company', name: 'Flent', objectSlug: null }],
    artifacts: ['transcript', 'recording_link'],
    noteId: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    title: 'Northgate catch-up',
    startsAt: '2026-10-13T15:00:00.000Z',
    endsAt: '2026-10-13T15:30:00.000Z',
    cancelled: true,
    participants: [],
    records: [],
    artifacts: [],
    noteId: null,
  },
]

async function render(props: {
  calendar: boolean
  audience?: SetupAudience
  meetings?: ReadonlyArray<DayMeeting> | 'failed' | null
  day?: string
}) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <MeetingsSection
          calendar={props.calendar}
          audience={props.audience ?? ADMIN}
          today="2026-10-13"
          day={props.day ?? '2026-10-13'}
          onDay={() => {}}
          meetings={props.meetings === undefined ? MEETINGS : props.meetings}
          onOpen={() => {}}
          onRetry={() => {}}
        />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/today'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

describe('MeetingsSection', () => {
  it('heads the day with its count once, the day nav and all meetings', async () => {
    const html = await render({ calendar: true })
    expect(html).toMatch(/Meetings<span[^>]*>2<\/span>/)
    expect(html.match(/>2</g)).toHaveLength(1)
    expect(html).toContain('aria-label="Previous day"')
    expect(html).toContain('>today<')
    expect(html).toContain('aria-label="Next day"')
    expect(html).toContain('href="/meetings"')
    expect(html).toContain('all meetings ›')
  })

  it('names the day away from today, as a way back', async () => {
    const html = await render({ calendar: true, day: '2026-10-14' })
    expect(html).toContain('>tomorrow<')
    expect(html).toContain('title="Back to today"')
  })

  it('prints each participant with the RSVP mark, the records and the artifacts, and no control over the answer', async () => {
    const html = await render({ calendar: true })
    expect(html).toContain('Flent intro')
    expect(html).toContain('Ana Reyes')
    expect(html).toContain('title="accepted">✓<')
    expect(html).toContain('ben@flent.io')
    expect(html).toContain('title="declined">✕<')
    expect(html).toContain('>Flent<')
    expect(html).toContain('transcript · recording')
    expect(html).not.toMatch(/<select|role="radio"|Accept invite|RSVP/)
  })

  it('keeps a cancelled meeting, struck and marked', async () => {
    const html = await render({ calendar: true })
    expect(html).toMatch(/line-through[^>]*>Northgate catch-up</)
    expect(html).toContain('>cancelled<')
  })

  it('keeps a failed read apart from an empty day, with a retry and no count', async () => {
    const html = await render({ calendar: true, meetings: 'failed' })
    expect(html).toContain('read failed')
    expect(html).toContain('retry ›')
    expect(html).not.toContain('No meetings.')
    expect(html).toMatch(/Meetings<\/h2>/)
  })

  it('says an empty day in one line', async () => {
    const html = await render({ calendar: true, meetings: [] })
    expect(html).toContain('No meetings.')
  })

  it('is the one D80 line with no calendar: a link for an admin, an admin named for a member', async () => {
    const admin = await render({ calendar: false })
    expect(admin).toContain('No calendar connected · ')
    expect(admin).toContain('href="/settings/email-calendar"')
    expect(admin).not.toContain('all meetings')
    expect(admin).not.toContain('Flent intro')

    const member = await render({
      calendar: false,
      audience: { isAdmin: false, admins: ['Anish'] },
    })
    expect(member).toContain('Ask Anish to set up Google')
    expect(member).not.toContain('href="/settings')
  })
})
