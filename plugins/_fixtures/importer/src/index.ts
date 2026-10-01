import { Effect } from 'effect'
import { Content, Identity, Log, definePlugin } from '@spaces/sdk'
import type { FilingTarget } from '@spaces/sdk'
import { manifest } from './manifest.ts'

/**
 * The importer's naming convention: `<company domain>__<title>.<ext>`, as a
 * data-room export names its files. A name without the separator, or whose
 * head is not a domain, files unfiled — to the inbox, not to a guess.
 */
const SEPARATOR = '__'
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i

/** The pure half: the company domain a filename names, or null. */
export const domainOf = (filename: string): string | null => {
  const at = filename.indexOf(SEPARATOR)
  if (at <= 0) return null
  const head = filename.slice(0, at)
  return DOMAIN.test(head) ? head.toLowerCase() : null
}

export default definePlugin({
  manifest,
  jobs: {
    // D52: the company is resolved first and the document names the id that
    // came back. The bytes go to the port as the stream they arrived as —
    // never read here: the size meter, the hash, the dedupe against a hand
    // upload and the extraction hand-off are all the host's intake.
    importDeck: ({ stream, filename, mime }) =>
      Effect.gen(function* () {
        const domain = domainOf(filename)
        const fileAgainst: Array<FilingTarget> = []
        if (domain !== null) {
          const { entityId } = yield* (yield* Identity).resolve({
            kind: 'company',
            keys: { domain },
          })
          fileAgainst.push({ kind: 'record', entityId })
        }
        const { documentId } = yield* (yield* Content).fileDocument({
          _tag: 'document',
          body: { stream },
          filename,
          mime,
          kind: 'deck',
          fileAgainst,
        })
        yield* (yield* Log).info('filed', {
          documentId,
          filename,
          filed: fileAgainst.length > 0,
        })
      }),
  },
})
