import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Google Calendar's manifest: a syncer.
 * - One `schedule` job. `uses` is a syncer's grant: the connection's token
 *   (Secrets), the provider (Http), the meeting lane (Content) and Log —
 *   never Facts, Identity or Ai. Attendees become records host-side, through
 *   the participants module mail uses.
 * - The connection asks `calendar.events.readonly` only; RSVP is shown,
 *   never edited.
 * - `sdk: '^1.4'`, as the watch fixture: raise it once an SDK release
 *   carries `logMeeting`, `connectedAt` and `CursorInvalid`.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'google-calendar',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Google Calendar',
  roles: ['email-calendar'],
  description:
    'Adds your external meetings to the timelines of the people and companies in them, from the day you connect: time, attendees and their answers follow the calendar, and a cancelled meeting is marked rather than removed. Internal meetings and ones you declined are left out.',
  requires: {
    connection: { provider: 'google', scopes: ['calendar.events.readonly'] },
  },
  settings: z.object({}),
  jobs: {
    sync: {
      trigger: 'schedule',
      schedule: '*/15 * * * *',
      uses: ['Secrets', 'Http', 'Content', 'Log'],
    },
  },
})
