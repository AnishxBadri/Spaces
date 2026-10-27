import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatTime } from '@spaces/core/format'
import type { SetupAudience, TodayMeeting } from '#/lib/server-fns'
import { MeetingsSection } from './meetings'

/**
 * Today's Meetings section: the head carries the day's count once in ink,
 * `‹ Today ›` and `All meetings ›`, with `Back to today` and the day away
 * from today; a row is the start time, the title, the action (Write after,
 * Prep before, Preparing… while it runs), who outside the workspace, and
 * `···`; every state is one line — cancelled, read failed, no calendar for
 * an admin and for a member, nothing that day.
 */

const ADMIN: SetupAudience = { isAdmin: true, admins: ['Anish'] }

const INTRO: TodayMeeting = {
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
  external: ['Ana Reyes', 'ben@flent.io'],
}

const MOVED: TodayMeeting = {
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Northgate catch-up',
  startsAt: '2026-10-13T15:00:00.000Z',
  endsAt: '2026-10-13T15:30:00.000Z',
  cancelled: true,
  participants: [],
  records: [],
  artifacts: [],
  noteId: null,
  external: [],
}

async function render(props: {
  calendar: boolean
  audience?: SetupAudience
  meetings?: ReadonlyArray<TodayMeeting> | 'failed' | null
  day?: string
  preparing?: string
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
          meetings={
            props.meetings === undefined ? [INTRO, MOVED] : props.meetings
          }
          preparing={props.preparing ?? null}
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

describe('MeetingsSection — the head', () => {
  it('carries the day’s count once, ‹ Today › and All meetings', async () => {
    const html = await render({ calendar: true })
    expect(html).toMatch(/data-section-count[^>]*text-foreground[^>]*>2</)
    expect(html.match(/>2</g)).toHaveLength(1)
    expect(html).toContain('aria-label="Previous day"')
    expect(html).toContain('>Today<')
    expect(html).toContain('aria-label="Next day"')
    expect(html).toContain('href="/meetings"')
    expect(html).toContain('All meetings ›')
    expect(html).not.toContain('Back to today')
  })

  it('names the day away from today, after Back to today', async () => {
    const html = await render({ calendar: true, day: '2026-10-14' })
    expect(html).toContain('>Wed 14 Oct<')
    expect(html).not.toContain('>Today<')
    expect(html.indexOf('Back to today')).toBeGreaterThan(-1)
    expect(html.indexOf('Back to today')).toBeLessThan(
      html.indexOf('aria-label="Previous day"'),
    )
  })
})

describe('MeetingsSection — the rows', () => {
  it('is the start time, the title, who outside the workspace, and ···', async () => {
    const html = await render({ calendar: true })
    expect(html).toContain(`>${formatTime(INTRO.startsAt)}<`)
    expect(html).toContain('>Flent intro<')
    expect(html).toContain('>Ana Reyes +1<')
    expect(html).toContain('aria-label="More for Flent intro"')
    // The shared row's RSVP marks, record chips and artifact marks are not Today's.
    expect(html).not.toContain('transcript · recording')
    expect(html).not.toContain('title="accepted"')
  })

  it('offers Write on a past day and Prep on a day ahead', async () => {
    const past = await render({
      calendar: true,
      day: '2026-10-12',
      meetings: [INTRO],
    })
    expect(past).toContain('>Write<')
    expect(past).toContain('data-today-meeting="ended"')
    expect(past).toMatch(/text-graphite[^>]*>Flent intro</)

    const ahead = await render({
      calendar: true,
      day: '2026-10-14',
      meetings: [INTRO],
    })
    expect(ahead).toContain('>Prep<')
    expect(ahead).toMatch(/text-foreground[^>]*>Flent intro</)
  })

  it('says Preparing… while Prep runs for the meeting', async () => {
    const html = await render({
      calendar: true,
      day: '2026-10-14',
      meetings: [INTRO],
      preparing: INTRO.id,
    })
    expect(html).toContain('Preparing…')
    expect(html).not.toContain('>Prep<')
  })

  it('keeps a cancelled meeting, struck and marked Cancelled, with no action', async () => {
    const html = await render({
      calendar: true,
      day: '2026-10-12',
      meetings: [MOVED],
    })
    expect(html).toMatch(/line-through[^>]*>Northgate catch-up</)
    expect(html).toContain('>Cancelled<')
    expect(html).not.toContain('>Write<')
  })
})

describe('MeetingsSection — the states', () => {
  it('reads Twinkle while the day is read', async () => {
    const html = await render({ calendar: true, meetings: null })
    expect(html).toContain('data-twinkle')
    expect(html).toContain('aria-label="Reading meetings"')
  })

  it('keeps a failed read apart from an empty day: a rose square, the words, Retry and no count', async () => {
    const html = await render({ calendar: true, meetings: 'failed' })
    expect(html).toContain('bg-destructive')
    expect(html).toContain(
      'Could not read the calendar · Google did not answer',
    )
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/)
    expect(html).not.toContain('No meetings')
    expect(html).not.toContain('data-section-count')
  })

  it('says an empty day in one line, with no count', async () => {
    const html = await render({ calendar: true, meetings: [] })
    expect(html).toContain('>No meetings<')
    expect(html).not.toContain('data-section-count')
  })

  it('is one line with no calendar: an ink link for an admin, an admin named for a member', async () => {
    const admin = await render({ calendar: false })
    expect(admin).toContain('No calendar connected')
    expect(admin).toMatch(
      /href="\/settings\/email-calendar"[^>]*text-foreground[^>]*>Connect Google ›</,
    )
    expect(admin).not.toContain('text-primary')
    expect(admin).not.toContain('All meetings')
    expect(admin).not.toContain('Flent intro')

    const member = await render({
      calendar: false,
      audience: { isAdmin: false, admins: ['Anish'] },
    })
    expect(member).toContain('Ask Anish to connect Google')
    expect(member).not.toContain('href="/settings')
  })
})
