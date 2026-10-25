import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Granola's manifest: a keyed recorder.
 * - `requires.connection.key`: each member pastes their own Granola key on
 *   You → Meeting notes, and the host runs `sync` once per member's
 *   connection, with that member's ticked folders and opt-ins.
 * - One `schedule` job about every 15 minutes: Granola sends no events.
 * - `uses` is a syncer's grant: the key (Secrets), the provider (Http), the
 *   recorder lane (Content) and Log — never Facts, Identity or Ai.
 * - `sdk: '^1.4'`, as google-calendar: raise it once an SDK release carries
 *   `logRecordedNote` and keyed connections.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'granola',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Granola',
  roles: ['meeting-notes'],
  description:
    'Adds the Granola notes each member chooses to share to the meetings they took them in. A member pastes their own Granola key and ticks the folders to share; a note outside those folders is never read, and one moved out of them, or deleted in Granola, leaves Spaces on the next sync.',
  requires: { connection: { provider: 'granola', key: true } },
  settings: z.object({}),
  jobs: {
    sync: {
      trigger: 'schedule',
      schedule: '*/15 * * * *',
      uses: ['Secrets', 'Http', 'Content', 'Log'],
    },
  },
})
