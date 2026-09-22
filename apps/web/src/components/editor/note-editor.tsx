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
import { TextSelection } from '@tiptap/pm/state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mention } from './mention'
import { createGlossaryExtension } from './glossary-decoration'
import type { GlossaryTerm } from './glossary-decoration'
import {
  HANDLE_MOTION,
  SHEET_MOTION,
  instrumentChrome,
} from './instrument-chrome'
import {
  isFileDrag,
  NOTE_DROP_LABEL,
  noteDropInsertPos,
} from '#/lib/documents/note-drop'
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

/**
 * What a resolved drop leaves in the body: the document that was born, as the
 * mention chip's two authoritative props. `null` is a drop that produced no
 * document — a refused file, a failed PUT — and leaves the note untouched.
 */
export type DroppedDocument = { entityId: string; label: string }

/**
 * One dropped file, uploaded. The editor owns the gesture (where the pointer
 * let go, what the body looks like while a file is over it, where the chip
 * lands); the caller owns the upload and everything it is told — which spaces
 * the document is filed in is a fact about the *page*, not about the editor.
 */
export type FileDropHandler = (file: File) => Promise<DroppedDocument | null>

export function NoteEditor({
  initialContent,
  terms = [],
  onChange,
  onFileDrop,
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
  /**
   * §3.1 entry point 4 (SPA-140), and **opt-in**: omitted, this editor is not
   * a file drop target at all and the browser and BlockNote handle a drop
   * exactly as they did before. Only the note page passes it — an interaction
   * write-up or a template body has no filing of its own to hand a document,
   * so giving them the gesture would mean inventing an answer for them.
   */
  onFileDrop?: FileDropHandler
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

  const dropZone = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  /**
   * The handler through a ref, so a caller that rebuilds its closure on every
   * render does not tear the listeners down and rebuild them mid-drag — the
   * one moment a `dragleave` with no matching `dragover` would leave the wash
   * stuck on. The effect below depends on whether there IS a handler, never
   * on which one.
   */
  const dropHandler = useRef<FileDropHandler | undefined>(undefined)
  useEffect(() => {
    dropHandler.current = onFileDrop
  }, [onFileDrop])
  const dropEnabled = onFileDrop !== undefined

  /**
   * Upload, then insert — never the other way round. There is no placeholder
   * chip: a chip that has to be removed again when the PUT fails is a second
   * write path into the note body, and the body is the source of truth
   * (CONTEXT.md → the glossary is decorations for the same reason). A failed
   * upload leaves the document exactly as the reader left it.
   *
   * `droppedAt` was resolved from the pointer inside the drop handler, before
   * any `await`, because by the time a hash and a PUT have finished there is
   * no pointer to ask — and it is re-validated against the document as it is
   * now, because there may have been seconds of typing in between.
   */
  const insertDropped = useCallback(
    async (
      files: Array<File>,
      droppedAt: number | null,
      handler: FileDropHandler,
    ) => {
      let pos = droppedAt
      for (const file of files) {
        // Serially, and one call each: the caller files each document
        // against every space at once, so N files is N documents, not N×M.
        const dropped = await handler(file)
        if (dropped === null) continue

        const view = editor.prosemirrorView
        const at = noteDropInsertPos(pos, view.state.doc.content.size)
        if (at !== null) {
          // `near`, not `create`: the coordinate may land on a node boundary
          // where a text selection cannot be made, and the nearest text
          // position is what the reader pointed at anyway.
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.near(view.state.doc.resolve(at)),
            ),
          )
        }
        view.focus()
        editor.insertInlineContent([
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- @blocknote's generics collapse to the default schema under exactOptionalPropertyTypes, so the mention spec is invisible here
          {
            type: 'mention',
            props: {
              entityId: dropped.entityId,
              label: dropped.label,
              kind: 'document',
              objectSlug: '',
            },
          } as never,
          ' ',
        ])
        // Two files in one drop read in the order they were dropped: the
        // second lands after the first's chip, not on top of it.
        pos = view.state.selection.from
      }
    },
    [editor],
  )

  /**
   * Native listeners in the **capture** phase, not React's `onDrop`: the
   * point is to reach the event before ProseMirror's own handler on the
   * editor node below, so BlockNote's file handling never runs and its drop
   * cursor never appears. `stopPropagation` in capture is what guarantees
   * that; `preventDefault` is what stops the browser navigating to the
   * dropped file, which would throw away an unsaved note.
   *
   * Both only for a drag carrying files — a block dragged by its handle is
   * BlockNote's, and passes straight through.
   */
  useEffect(() => {
    const el = dropZone.current
    if (el === null || !dropEnabled) return

    const onDragOver = (event: DragEvent) => {
      const dt = event.dataTransfer
      if (dt === null || !isFileDrag([...dt.types])) return
      event.preventDefault()
      event.stopPropagation()
      dt.dropEffect = 'copy'
      setDragging(true)
    }

    const onDragLeave = (event: DragEvent) => {
      // `dragleave` fires for every child crossed on the way across the
      // body; only the one that leaves the container for good points
      // somewhere outside it.
      const to = event.relatedTarget
      if (to instanceof Node && el.contains(to)) return
      setDragging(false)
    }

    const onDrop = (event: DragEvent) => {
      const dt = event.dataTransfer
      if (dt === null || !isFileDrag([...dt.types])) return
      event.preventDefault()
      event.stopPropagation()
      setDragging(false)
      const files = [...dt.files]
      const handler = dropHandler.current
      if (files.length === 0 || handler === undefined) return
      // Read the coordinate here, synchronously, while the pointer still
      // means something. Everything after this is asynchronous.
      const coords = editor.prosemirrorView.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      })
      void insertDropped(files, coords?.pos ?? null, handler)
    }

    const opts = { capture: true }
    el.addEventListener('dragover', onDragOver, opts)
    el.addEventListener('dragleave', onDragLeave, opts)
    el.addEventListener('drop', onDrop, opts)
    return () => {
      el.removeEventListener('dragover', onDragOver, opts)
      el.removeEventListener('dragleave', onDragLeave, opts)
      el.removeEventListener('drop', onDrop, opts)
    }
  }, [dropEnabled, editor, insertDropped])

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
    <div ref={dropZone} className="relative">
      {/* The drop affordance, and deliberately not the selection wash on its
          own: BlockNote already washes a selection and already draws a drop
          cursor, so the thing that says "this drop files a document" has to
          be the sentence. `pointer-events-none` keeps it out of the way of
          the coordinate the drop is about to resolve. */}
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center bg-selected pt-6">
          <span className="text-label text-graphite">{NOTE_DROP_LABEL}</span>
        </div>
      ) : null}
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
    </div>
  )
}
