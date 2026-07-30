import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { buildAutomaton, findMatches } from '#/lib/glossary/aho-corasick'
import type { Automaton, Pattern } from '#/lib/glossary/aho-corasick'

/**
 * Glossary auto-linking, as decorations rather than document content.
 *
 * This is the escape hatch CONTEXT.md reserved — BlockNote's inline-content
 * API can insert nodes, but a term highlight must not *be* a node: the note
 * JSON is authoritative, and writing highlights into it would mean editing
 * every stored note whenever a definition is renamed or deleted, and would
 * put derived data in the source of truth. Decorations are presentation
 * only, recomputed at render, and vanish when a term does.
 *
 * Reached through BlockNote's `_tiptapOptions.extensions`.
 */

export type GlossaryTerm = {
  id: string
  name: string
  aliases: Array<string>
  definitionMd: string
}

export const glossaryPluginKey = new PluginKey('dealos-glossary')

function patternsOf(terms: Array<GlossaryTerm>): Array<Pattern> {
  const out: Array<Pattern> = []
  for (const t of terms) {
    out.push({ id: t.id, text: t.name })
    for (const alias of t.aliases) out.push({ id: t.id, text: alias })
  }
  return out
}

/**
 * Decorate each text node independently. Doing it per text node rather than
 * over the flattened document keeps position maths trivial and correct —
 * a term never spans a node boundary, and inline marks split text nodes at
 * unpredictable points.
 */
function decorate(doc: any, automaton: Automaton, byId: Map<string, GlossaryTerm>) {
  if (automaton.empty) return DecorationSet.empty
  const decorations: Array<Decoration> = []

  doc.descendants((node: any, pos: number) => {
    if (!node.isText || !node.text) return
    for (const m of findMatches(automaton, node.text)) {
      const t = byId.get(m.id)
      if (!t) continue
      decorations.push(
        Decoration.inline(pos + m.start, pos + m.end, {
          class: 'glossary-term',
          // Definition in a title attribute: a native tooltip needs no
          // portal, no positioning, and no state inside the editor view.
          title: `${t.name} — ${t.definitionMd || 'No definition yet'}`,
          'data-term-id': t.id,
        }),
      )
    }
  })

  return DecorationSet.create(doc, decorations)
}

export function createGlossaryExtension(terms: Array<GlossaryTerm>) {
  const automaton = buildAutomaton(patternsOf(terms))
  const byId = new Map(terms.map((t) => [t.id, t]))

  return Extension.create({
    name: 'dealosGlossary',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: glossaryPluginKey,
          state: {
            init: (_config, state) => decorate(state.doc, automaton, byId),
            // Only recompute when the document actually changed — selection
            // moves fire transactions constantly and re-scanning on every
            // caret step is how an editor starts feeling heavy.
            apply: (tr, old) =>
              tr.docChanged ? decorate(tr.doc, automaton, byId) : old,
          },
          props: {
            decorations(state) {
              return glossaryPluginKey.getState(state) as DecorationSet
            },
          },
        }),
      ]
    },
  })
}
