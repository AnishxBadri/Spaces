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
import type { Json } from '#/lib/json'
import type { NoteBody } from '@spaces/db/schema/kinds'

const schema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: Mention,
  },
})

/**
 * The editor's document as the column stores it. BlockNote's Block type is
 * its own closed schema; the stored shape is plain JSON, and the round-trip
 * is exactly what the wire does a moment later — so this converts rather
 * than asserts.
 */
export function toNoteBody(doc: unknown): NoteBody {
  const round: unknown = JSON.parse(JSON.stringify(doc ?? []))
  return Array.isArray(round) ? round : []
}

/** Walk the doc and collect every mentioned entity id (deduped). */
export function extractMentionIds(doc: Json): Array<string> {
  const ids = new Set<string>()
  const walk = (node: Json) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (node.type === 'mention') {
      const id = mentionProp(node.props, 'entityId')
      if (id) ids.add(id)
    }
    if (node.content) walk(node.content)
    if (node.children) walk(node.children)
  }
  walk(doc)
  return [...ids]
}

/** One string prop off a mention's props object, or '' if it isn't there. */
function mentionProp(props: Json | undefined, key: string): string {
  if (props === null || typeof props !== 'object' || Array.isArray(props))
    return ''
  const v = props[key]
  return typeof v === 'string' ? v : ''
}

/**
 * Derived markdown for search/embeddings/export. BlockNote's export is
 * lossy and drops custom inline content, so mentions are appended as a
 * trailer of [[Label|entity:id]] references — searchable and greppable
 * even if not positionally faithful.
 */
export function deriveMarkdown(lossyMd: string, doc: Json): string {
  const mentions: Array<{ id: string; label: string }> = []
  const seen = new Set<string>()
  const walk = (node: Json) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node === null || typeof node !== 'object') return
    if (node.type === 'mention') {
      const id = mentionProp(node.props, 'entityId')
      if (id && !seen.has(id)) {
        seen.add(id)
        mentions.push({ id, label: mentionProp(node.props, 'label') })
      }
    }
    if (node.content) walk(node.content)
    if (node.children) walk(node.children)
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
  initialContent: NoteBody | null
  /**
   * Glossary terms in scope, from the spaces this note is filed in. Captured
   * when the editor is created — defining a new term while a note is open
   * highlights it on the next load, not live. Recreating the editor to pick
   * up a term set would throw away cursor and undo history, which is a worse
   * trade than a stale highlight.
   */
  terms?: Array<GlossaryTerm>
  onChange: (editor: {
    document: NoteBody
    blocksToMarkdownLossy: () => Promise<string>
  }) => void
}) {
  const editor = useCreateBlockNote(
    {
      schema,
      // An empty body is an omitted option, not an undefined one: BlockNote
      // declares `initialContent?: PartialBlock[]`, so passing `undefined`
      // is a type error under exactOptionalPropertyTypes.
      ...(initialContent && initialContent.length > 0
        ? {
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- BlockNote's PartialBlock generic is its own closed schema; stored JSON enters through this one seam
            initialContent: initialContent as never,
          }
        : {}),
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
              // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- @blocknote's generics collapse to the default schema under exactOptionalPropertyTypes, so the mention spec is invisible here
              {
                type: 'mention',
                props: {
                  entityId: r.id,
                  label: r.name,
                  kind: r.kind,
                  objectSlug: r.objectSlug ?? '',
                },
              } as never,
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
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- @blocknote's editor/view generics are not exactOptionalPropertyTypes-clean (PartialBlock variance)
      editor={editor as never}
      theme="light"
      onChange={() =>
        onChange({
          document: toNoteBody(editor.document),
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
