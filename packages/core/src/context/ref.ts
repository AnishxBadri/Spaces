/**
 * Citation refs — the `ContextItem.ref` grammar. One builder and one parser
 * so nothing else in the codebase formats these by hand.
 *
 *   attr:<entityId>:<slug>     an attribute value on a record
 *   note:<entityId>            a note body
 *   memo:<entityId>            a memo (note with kind=memo)
 *   doc:<entityId>#<idx>       one chunk of a document — chunk index, not
 *                              chunk uuid, so a re-chunk keeps citations
 *   event:<id>                 an attribute_event / signal / ledger row
 *   interaction:<id>
 *   task:<id>
 *   mandate:<id>
 *   term:<entityId>            a glossary term
 *
 * Entity ids inside refs may be merged losers; resolvers follow
 * merged_into_id at read time (decided 2026-09-09).
 */

export type ParsedRef =
  | { kind: 'attr'; entityId: string; slug: string }
  | { kind: 'note'; entityId: string }
  | { kind: 'memo'; entityId: string }
  | { kind: 'doc'; entityId: string; idx: number }
  | { kind: 'event'; id: string }
  | { kind: 'interaction'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'mandate'; id: string }
  | { kind: 'term'; entityId: string }

export const ref = {
  attr: (entityId: string, slug: string) => `attr:${entityId}:${slug}`,
  note: (entityId: string) => `note:${entityId}`,
  memo: (entityId: string) => `memo:${entityId}`,
  doc: (entityId: string, idx: number) => `doc:${entityId}#${idx}`,
  event: (id: string) => `event:${id}`,
  interaction: (id: string) => `interaction:${id}`,
  task: (id: string) => `task:${id}`,
  mandate: (id: string) => `mandate:${id}`,
  term: (entityId: string) => `term:${entityId}`,
} as const

export function parseRef(s: string): ParsedRef | null {
  const i = s.indexOf(':')
  if (i < 0) return null
  const kind = s.slice(0, i)
  const rest = s.slice(i + 1)
  if (!rest) return null
  switch (kind) {
    case 'attr': {
      const j = rest.indexOf(':')
      if (j <= 0 || j === rest.length - 1) return null
      return { kind, entityId: rest.slice(0, j), slug: rest.slice(j + 1) }
    }
    case 'doc': {
      const j = rest.indexOf('#')
      if (j <= 0) return null
      const idx = Number(rest.slice(j + 1))
      if (!Number.isInteger(idx) || idx < 0) return null
      return { kind, entityId: rest.slice(0, j), idx }
    }
    case 'note':
    case 'memo':
    case 'term':
      return { kind, entityId: rest }
    case 'event':
    case 'interaction':
    case 'task':
    case 'mandate':
      return { kind, id: rest }
    default:
      return null
  }
}

/** The document a chunk ref belongs to, for the one-chunk-per-doc floor. */
export function docOfRef(s: string): string | null {
  const p = parseRef(s)
  return p?.kind === 'doc' ? p.entityId : null
}
