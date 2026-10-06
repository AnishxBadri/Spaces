import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Call-recorder shaped: a provider pushes a delivery, web checks its
 * HMAC-SHA256 signature against the saved webhook secret, and `ingest`
 * turns it into a signal.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'hooked',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Hooked',
  description:
    'A fixture plugin: a webhook job that emits each signed delivery as a signal on the record it names.',
  settings: z.object({}),
  jobs: {
    ingest: { trigger: 'webhook', uses: ['Content', 'Log'] },
  },
  ingress: { signature: 'hmac-sha256' },
})
