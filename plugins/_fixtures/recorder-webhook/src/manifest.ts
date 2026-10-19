import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * A webhook recorder (D78): Fathom or tl;dv pushes a delivery, web checks
 * its HMAC-SHA256 signature against the saved secret, and `ingest` hands it
 * to the host as a recorded note — the contract Granola's schedule job uses.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'recorder-webhook',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Recorder webhook',
  roles: ['meeting-notes'],
  description:
    'A fixture plugin: a webhook job that hands each signed Fathom or tl;dv delivery to the host as a recorded note.',
  settings: z.object({}),
  jobs: {
    ingest: { trigger: 'webhook', uses: ['Content', 'Log'] },
  },
  ingress: { signature: 'hmac-sha256' },
})
