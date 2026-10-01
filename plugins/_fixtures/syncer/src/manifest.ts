import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Sync-shaped (sdk-7b): resume from the cursor, page the provider, resolve
 * each participant, log each message, hand back the next cursor. `uses`
 * deliberately lacks Facts — a syncer files evidence and never writes an
 * attribute.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'syncer',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Syncer',
  description:
    'A fixture plugin: a schedule job that pages a mail provider and logs each message as an interaction.',
  settings: z.object({}),
  jobs: {
    sync: {
      trigger: 'schedule',
      // Every 15 minutes: a schedule job must carry its cron (manifestSchema),
      // and the build's manifest plugin refuses the bundle without it.
      schedule: '*/15 * * * *',
      uses: ['Http', 'Identity', 'Content', 'Log'],
    },
  },
})
