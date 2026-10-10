import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** One company a watch run hands back. */
const candidate = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  evidence: z
    .array(z.object({ url: z.string(), title: z.string().optional() }))
    .default([]),
  subspaceHint: z.string().optional(),
})

/** What one watch holds: the candidates it finds, and whether to overreach. */
export const findSettings = z.object({
  candidates: z.array(candidate).default([]),
  reachForFacts: z.boolean().default(false),
})

/** One watch job granted Spaces, Discover, Content and Log — never Facts. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'discover',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Discover',
  description:
    'A loader fixture: a watch job that signals on its space members and hands back the candidates its settings list.',
  settings: z.object({}),
  jobs: {
    find: {
      trigger: 'watch',
      uses: ['Spaces', 'Discover', 'Content', 'Log'],
      settings: findSettings,
    },
  },
})
