/**
 * The LAYOUT half of BlockNote, and only that: this file is
 * `@blocknote/react/style.css` (which is `@blocknote/core/style.css` plus the
 * floating-element geometry) and a dozen `.bn-shadcn` rules that size the side
 * menu, the table cell handle and the toolbar's overflow. It carries no
 * shadow, no radius, no font and no colour the app has not already replaced —
 * the visual half of the shadcn theme was never in this stylesheet, it is
 * Tailwind class names emitted by the vendor's own JSX, which the app's
 * Tailwind build does not scan and therefore never builds. The VISUAL half is
 * the app's, in the `.prose-note` block of `src/styles.css`. Keep the import:
 * without it the editor has no block layout at all.
 */
import '@blocknote/shadcn/style.css'

import {
  BlockNoteSchema,
  defaultInlineContentSpecs,
  filterSuggestionItems,
} from '@blocknote/core'
import { BlockNoteView } from '@blocknote/shadcn'
import {
  FormattingToolbarController,
  LinkToolbarController,
  SideMenuController,
  SuggestionMenuController,
  useCreateBlockNote,
} from '@blocknote/react'
import { useMemo } from 'react'
import { Mention } from './mention'
import { createGlossaryExtension } from './glossary-decoration'
import type { GlossaryTerm } from './glossary-decoration'
import {
  HANDLE_MOTION,
  SHEET_MOTION,
  instrumentChrome,
} from './instrument-chrome'
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
      /**
       * WHICH SURFACE WENT WHICH WAY — the map the next BlockNote upgrade
       * needs. Three seams, because BlockNote builds its chrome three ways.
       *
       * 1. COMPONENT OVERRIDE (`shadCNComponents`, here → `instrument-chrome
       *    .tsx`). BlockNote reads these out of its own context, so handing it
       *    the app's primitives means the surface is drawn by the same file
       *    the rest of the app is drawn by and needs no CSS at all:
       *      Button        the drag handle, the `+`, every toolbar button
       *      DropdownMenu  the drag-handle block menu, the toolbar dropdowns
       *      Popover       edit-link, create-link, file caption and rename
       *      Tooltip       a toolbar button's name on hover
       *      Input, Label  the URL field inside those
       *      Toggle        bold/italic — the one adapter, over `Button`
       *
       * 2. CSS, in the `.prose-note` block of `src/styles.css`. These BlockNote
       *    builds from its own markup with shadcn class names it never reads
       *    from the context, so there is no seam to hand anything to:
       *      .bn-suggestion-menu  the slash menu AND the @-mention menu
       *      .bn-toolbar          the formatting and link toolbar sheets
       *      .bn-side-menu        the handle colour (geometry left alone)
       *      .bn-table-handle     colour and radius only, per the same rule
       *      .bn-select, badge    the block-type picker and the kind chip —
       *                           the two groups with no app primitive behind
       *                           them, so they are dressed, not replaced
       *      --bn-*               BlockNote's own variables: radius, 1px ink
       *                           edge, the grey ramp → Instrument materials
       *
       * 3. MOTION (`floatingUIOptions`, below). Every floating element's enter
       *    and exit is a floating-ui INLINE style, which neither seam above
       *    can reach — so the four default controllers are switched off and
       *    re-rendered here by hand, each carrying the timing. See
       *    `instrument-chrome.tsx` for why the scale half lives in CSS.
       */
      shadCNComponents={instrumentChrome}
      formattingToolbar={false}
      linkToolbar={false}
      slashMenu={false}
      sideMenu={false}
      onChange={() =>
        onChange({
          document: toNoteBody(editor.document),
          // async-wrapped: API is sync in some versions, async in others
          blocksToMarkdownLossy: async () => editor.blocksToMarkdownLossy(),
        })
      }
    >
      <FormattingToolbarController floatingUIOptions={SHEET_MOTION} />
      <LinkToolbarController floatingUIOptions={SHEET_MOTION} />
      <SideMenuController floatingUIOptions={HANDLE_MOTION} />
      <SuggestionMenuController
        triggerCharacter="/"
        // Verbatim from BlockNote's own default slash menu
        // (BlockNoteDefaultUI.tsx): a table cell is not a place to insert a
        // block. Switching the default controller off is what makes this our
        // line to keep.
        shouldOpen={(tr) =>
          !tr.selection.$from.parent.type.isInGroup('tableContent')
        }
        floatingUIOptions={SHEET_MOTION}
      />
      <SuggestionMenuController
        triggerCharacter="@"
        minQueryLength={1}
        getItems={getMentionItems}
        floatingUIOptions={SHEET_MOTION}
      />
    </BlockNoteView>
  )
}
