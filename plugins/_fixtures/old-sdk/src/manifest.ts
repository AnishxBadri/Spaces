import { Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'old-sdk',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'old-sdk',
  description:
    'A loader fixture (sdk-11): built for SDK 1.x, a major this host does not provide, so boot degrades it.',
  settings: Schema.Struct({}),
  jobs: {
    ping: { trigger: 'action', uses: ['Log'] },
  },
})
