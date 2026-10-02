import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** The manifest at `version`: one action job, `stamp`, on Log. */
export const manifestAt = (version: string) =>
  defineManifest({
    manifestVersion: 1,
    id: 'versioned',
    version,
    sdk: '^1.0',
    name: 'Versioned',
    description:
      'An upgrade fixture: a stamp job that logs the version it was built as.',
    settings: z.object({}),
    jobs: { stamp: { trigger: 'action', uses: ['Log'] } },
  })
