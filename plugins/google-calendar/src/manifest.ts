import { Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/**
 * Google Calendar's manifest: a syncer.
 * - One `schedule` job. `uses` is a syncer's grant: the connection's token
 *   (Secrets), the provider (Http), the meeting lane (Content) and Log —
 *   never Facts, Identity or Ai. Attendees become records host-side, through
 *   the participants module mail uses.
 * - The connection asks `calendar.events.readonly` only; RSVP is shown,
 *   never edited.
 * - `sdk: '^2.1'`: settings are an Effect schema, and a claim carries the
 *   event's place, which a 2.0 host refuses as an unknown field.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'google-calendar',
  version: '0.2.0',
  sdk: '^2.1',
  name: 'Google Calendar',
  roles: ['email-calendar'],
  description:
    'Adds your external meetings to the timelines of the people and companies in them, from the day you connect: time, place, attendees and their answers follow the calendar, and a cancelled meeting is marked rather than removed. Internal meetings, ones you declined, all-day and private events, and out-of-office or focus blocks are left out.',
  requires: {
    connection: { provider: 'google', scopes: ['calendar.events.readonly'] },
  },
  settings: Schema.Struct({}),
  jobs: {
    sync: {
      trigger: 'schedule',
      schedule: '*/15 * * * *',
      uses: ['Secrets', 'Http', 'Content', 'Log'],
    },
  },
})
