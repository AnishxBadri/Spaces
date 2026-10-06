import { Effect } from 'effect'
import { Import, JobPermanent, Log, definePlugin } from '@spaces/sdk'
import type { FileInput } from '@spaces/sdk'
import { airtableGrid } from './dialect.ts'
import { manifest } from './manifest.ts'

/** The whole stream as text; an export is one CSV, read once. */
const readText = (stream: ReadableStream<Uint8Array>, filename: string) =>
  Effect.tryPromise({
    try: async () => {
      const decoder = new TextDecoder('utf-8')
      const reader = stream.getReader()
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
      return text + decoder.decode()
    },
    catch: () => new JobPermanent({ reason: `${filename} could not be read` }),
  })

/** The jobs as written; `definePlugin` checks each `R` against its `uses`. */
export const jobs = {
  /**
   * The export, read as Airtable writes it, handed to core as one grid
   * (D39 as amended). Core lands it in the batch the import wizard is
   * waiting on; mapping, preview and commit are the wizard's.
   */
  stage: Effect.fn('airtable.stage')(function* ({
    stream,
    filename,
  }: FileInput) {
    const text = yield* readText(stream, filename)
    const grid = airtableGrid(text)
    if (grid === null)
      return yield* new JobPermanent({
        reason: `${filename} has no header row`,
      })
    const staged = yield* (yield* Import).stage({
      columns: grid.columns,
      rows: grid.rows,
    })
    yield* (yield* Log).info('staged', {
      batchId: staged.batchId,
      staged: staged.staged,
      malformed: staged.malformed.length,
      refused: staged.refused.length,
      lists: grid.columns.filter((_, i) => grid.kinds.at(i) === 'list'),
      attachments: grid.columns.filter(
        (_, i) => grid.kinds.at(i) === 'attachments',
      ),
    })
  }),
}

export default definePlugin({ manifest, jobs })
