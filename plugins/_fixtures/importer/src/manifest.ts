import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Importer-shaped (sdk-8): a `file` job is handed a stream, a filename and
 * a mime, and speaks claims through the ports (D39, D52) — here, one
 * Identity resolve for the company the filename names and one
 * Content.fileDocument with the bytes. `uses` lacks Facts: filing a
 * document never writes an attribute.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'importer',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Importer',
  description:
    'A fixture plugin: a file job that files an uploaded deck against the company its filename names.',
  settings: z.object({}),
  jobs: {
    importDeck: {
      trigger: 'file',
      uses: ['Identity', 'Content', 'Log'],
    },
  },
})
