import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Airtable's manifest: one `file` job, granted Import and Log only — it
 * hands core a grid and says what it read, and writes nothing else.
 * - `accepts` is Airtable's export name, `<table>-<view>.csv`, where every
 *   built-in view's name ends in "view" (`Grid view`, `Kanban view`); a
 *   browser's ` (1)` on a second download still matches. A renamed view's
 *   export takes the plain CSV path and its mapping step.
 * - `sdk: '^1.4'`: the first SDK with `roles` (Import and `accepts` need 1.1).
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'airtable',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Airtable',
  roles: ['import'],
  description:
    'Reads an Airtable CSV export dropped on Import: multi-select and linked-record cells become lists, attachments their URLs. You map, preview and commit it like any spreadsheet.',
  settings: z.object({}),
  jobs: {
    stage: {
      trigger: 'file',
      uses: ['Import', 'Log'],
      accepts: { filename: '-[^\\\\/]+ view(?: \\(\\d+\\))?\\.csv$' },
    },
  },
})
