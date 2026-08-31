import '@blocknote/shadcn/style.css'

import {
  BlockNoteSchema,
  defaultInlineContentSpecs,
  filterSuggestionItems,
} from '@blocknote/core'
import { BlockNoteView } from '@blocknote/shadcn'
import { SuggestionMenuController, useCreateBlockNote } from '@blocknote/react'
import { useMemo } from 'react'
import { Mention } from './mention'
import { createGlossaryExtension } from './glossary-decoration'
import type { GlossaryTerm } from './glossary-decoration'
import { searchEntities } from '#/lib/server-fns'

const schema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: Mention,
  },
})

/** Walk the doc and collect every mentioned entity id (deduped). */
export function extractMentionIds(doc: unknown): Array<string> {
  const ids = new Set<string>()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n.type === 'mention') {
      const props = n.props as { entityId?: string } | undefined
      if (props?.entityId) ids.add(props.entityId)
    }
    if (n.content) walk(n.content)
    if (n.children) walk(n.children)
  }
  walk(doc)
  return [...ids]
}

/**
 * Derived markdown for search/embeddings/export. BlockNote's export is
 * lossy and drops custom inline content, so mentions are appended as a
 * trailer of [[Label|entity:id]] references — searchable and greppable
 * even if not positionally faithful.
 */
export function deriveMarkdown(lossyMd: string, doc: unknown): string {
  const mentions: Array<{ id: string; label: string }> = []
  const seen = new Set<string>()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n.type === 'mention') {
      const props = n.props as { entityId?: string; label?: string } | undefined
      if (props?.entityId && !seen.has(props.entityId)) {
        seen.add(props.entityId)
        mentions.push({ id: props.entityId, label: props.label ?? '' })
      }
    }
    if (n.content) walk(n.content)
    if (n.children) walk(n.children)
  }
  walk(doc)
  if (mentions.length === 0) return lossyMd
  const trailer = mentions.map((m) => `[[${m.label}|entity:${m.id}]]`).join(' ')
  return `${lossyMd.trimEnd()}\n\nMentions: ${trailer}\n`
}

export function NoteEditor({
  initialContent,
  terms = [],
  onChange,
}: {
  initialContent: unknown
  /**
   * Glossary terms in scope, from the spaces this note is filed in. Captured
   * when the editor is created — defining a new term while a note is open
   * highlights it on the next load, not live. Recreating the editor to pick
   * up a term set would throw away cursor and undo history, which is a worse
   * trade than a stale highlight.
   */
  terms?: Array<GlossaryTerm>
  onChange: (editor: {
    document: unknown
    blocksToMarkdownLossy: () => Promise<string>
  }) => void
}) {
  const editor = useCreateBlockNote(
    {
      schema,
      initialContent:
        Array.isArray(initialContent) && initialContent.length > 0
          ? (initialContent as never)
          : undefined,
      _tiptapOptions: {
        extensions: [createGlossaryExtension(terms)],
      },
    },
    [],
  )

  const getMentionItems = useMemo(
    () => async (query: string) => {
      const results = await searchEntities({ data: { q: query } })
      return filterSuggestionItems(
        results.map((r) => ({
          title: r.name,
          badge: r.kind,
          onItemClick: () => {
            editor.insertInlineContent([
              {
                type: 'mention',
                props: { entityId: r.id, label: r.name, kind: r.kind },
              },
              ' ',
            ])
          },
        })),
        query,
      )
    },
    [editor],
  )

  return (
    <BlockNoteView
      editor={editor}
      theme="light"
      onChange={() =>
        onChange({
          document: editor.document,
          // async-wrapped: API is sync in some versions, async in others
          blocksToMarkdownLossy: async () => editor.blocksToMarkdownLossy(),
        })
      }
    >
      <SuggestionMenuController
        triggerCharacter="@"
        minQueryLength={1}
        getItems={getMentionItems}
      />
    </BlockNoteView>
  )
}
