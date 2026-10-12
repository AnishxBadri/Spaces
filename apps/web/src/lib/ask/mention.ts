import { recordPath } from '#/lib/record-path'
import type { AskScopeChip } from './types'

/**
 * `@` in Ask's composer: where a mention is being typed, and what a chosen
 * hit becomes. Pure, so the composer and a test share it. (D70)
 */

/** Longest name typed after `@` before the popover gives up. */
const MENTION_MAX = 60

export type MentionAt = { start: number; query: string }

/**
 * The mention the caret is in: an `@` at the start or after whitespace,
 * then up to the caret on one line. Null when there is none.
 */
export function mentionAt(text: string, caret: number): MentionAt | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.includes('\n') || query.length > MENTION_MAX) return null
  if (/^\s/.test(query)) return null
  return { start: at, query }
}

/** The text with the typed `@query` replaced by the name, and the caret after it. */
export function insertMention(
  text: string,
  at: MentionAt,
  name: string,
): { text: string; caret: number } {
  const end = at.start + 1 + at.query.length
  const rest = text.slice(end)
  const insert = rest.startsWith(' ') ? name : `${name} `
  return {
    text: `${text.slice(0, at.start)}${insert}${rest}`,
    caret: at.start + insert.length,
  }
}

/** The kinds `@` offers: spaces and records. */
const MENTIONABLE = new Set(['company', 'person', 'deal', 'custom', 'space'])

export type MentionHit = {
  id: string
  kind: string
  name: string
  objectSlug: string | null
  rowKind: 'entity' | 'task'
}

/** A finder hit as a scope chip; null for anything `@` does not offer. */
export function chipOfHit(hit: MentionHit): AskScopeChip | null {
  if (hit.rowKind !== 'entity' || !MENTIONABLE.has(hit.kind)) return null
  return {
    kind:
      hit.kind === 'space'
        ? 'space'
        : hit.kind === 'person'
          ? 'person'
          : 'record',
    id: hit.id,
    name: hit.name,
    href: recordPath(hit),
  }
}
