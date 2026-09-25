import { BlockNoteEditor } from '@blocknote/core'
import { describe, expect, it } from 'vitest'
import { jsonValue } from '#/lib/json'
import type { Json } from '#/lib/json'
import {
  blocksToMarkdown,
  markdownToBlocks,
  noteBodyFromMarkdown,
  parseInline,
} from './markdown-blocks'
import { editorBlocks } from '#/test/note-blocks'

/**
 * SPA-66. The server's markdown → BlockNote renderer, pure: nothing here
 * reads a database or a clock. The editor round trip at the bottom loads the
 * blocks into a real (headless) BlockNote editor — the same schema check the
 * note page runs when it opens a note — and reads its document back.
 */

const P = {
  backgroundColor: 'default',
  textColor: 'default',
  textAlignment: 'left',
}

const text = (t: string, styles: Record<string, true> = {}) => ({
  type: 'text',
  text: t,
  styles,
})

/** A document read back out of BlockNote, as the column would store it. */
function stored(doc: unknown): Array<Json> {
  const round = jsonValue.parse(JSON.parse(JSON.stringify(doc)))
  return Array.isArray(round) ? round : []
}

/** BlockNote mints an id per block on load; strip them to compare shape. */
function withoutIds(blocks: Array<Json>): Array<Json> {
  return blocks.map((b) => {
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return b
    const { id: _id, children, ...rest } = b
    return {
      ...rest,
      children: Array.isArray(children) ? withoutIds(children) : [],
    }
  })
}

const SUMMARY = [
  'Acme sells liquid cooling to edge operators (acme\\_dd.pdf, p.4).',
  '',
  '## Traction',
  '',
  '- **ARR** of $1.2M, up *3x* year on year (acme\\_dd.pdf, p.12)',
  '- Pilots with two operators',
  '  - one in Berlin, see [the site](https://acme.example/berlin)',
  '- `SOC 2` in progress',
  '',
  '## Risks',
  '',
  'Customer concentration: the top two are 70% of revenue.',
].join('\n')

describe('parseInline', () => {
  it('reads links, bold, italic and code into styled runs', () => {
    expect(
      parseInline('a **b** *c* _d_ `e` [f **g**](https://x.example)'),
    ).toEqual([
      text('a '),
      text('b', { bold: true }),
      text(' '),
      text('c', { italic: true }),
      text(' '),
      text('d', { italic: true }),
      text(' '),
      text('e', { code: true }),
      text(' '),
      {
        type: 'link',
        href: 'https://x.example',
        content: [text('f '), text('g', { bold: true })],
      },
    ])
  })

  it('keeps an escaped marker, and a bracket that is not a link, as text', () => {
    expect(parseInline('dd\\_pack\\_v2.pdf and [p.4]')).toEqual([
      text('dd_pack_v2.pdf and [p.4]'),
    ])
  })

  it('does not read an intraword underscore as emphasis', () => {
    expect(parseInline('snake_case_name')).toEqual([text('snake_case_name')])
  })
})

describe('markdownToBlocks', () => {
  it('renders paragraphs, headings and nested bullets', () => {
    const blocks = markdownToBlocks(SUMMARY)
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'heading',
      'bulletListItem',
      'bulletListItem',
      'bulletListItem',
      'heading',
      'paragraph',
    ])
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      props: P,
      content: [
        text('Acme sells liquid cooling to edge operators (acme_dd.pdf, p.4).'),
      ],
      children: [],
    })
    expect(blocks[1]).toEqual({
      type: 'heading',
      props: { ...P, level: 2, isToggleable: false },
      content: [text('Traction')],
      children: [],
    })
    // The indented bullet is a child of the one above it.
    expect(blocks[3].children).toEqual([
      {
        type: 'bulletListItem',
        props: P,
        content: [
          text('one in Berlin, see '),
          {
            type: 'link',
            href: 'https://acme.example/berlin',
            content: [text('the site')],
          },
        ],
        children: [],
      },
    ])
  })

  it('joins a paragraph’s lines and keeps an unknown construct as text', () => {
    const blocks = markdownToBlocks(
      'one\ntwo\n\n1. first\n> quoted\n\n---\n\n```\ncode line\n```',
    )
    expect(blocks.map((b) => b.content)).toEqual([
      [text('one two')],
      [text('1. first quoted')],
      [text('code line')],
    ])
  })

  it('writes nothing for empty markdown', () => {
    expect(markdownToBlocks('  \n\n')).toEqual([])
  })
})

describe('blocksToMarkdown', () => {
  it('serializes the blocks it renders, and reads back to the same blocks', () => {
    const blocks = markdownToBlocks(SUMMARY)
    const md = blocksToMarkdown(blocks)
    expect(md).toBe(
      [
        'Acme sells liquid cooling to edge operators (acme\\_dd.pdf, p.4).',
        '',
        '## Traction',
        '',
        '- **ARR** of $1.2M, up *3x* year on year (acme\\_dd.pdf, p.12)',
        '- Pilots with two operators',
        '  - one in Berlin, see [the site](https://acme.example/berlin)',
        '- `SOC 2` in progress',
        '',
        '## Risks',
        '',
        'Customer concentration: the top two are 70% of revenue.',
        '',
      ].join('\n'),
    )
    expect(markdownToBlocks(md)).toEqual(blocks)
  })

  it('escapes text that would otherwise read back as syntax', () => {
    const blocks = markdownToBlocks('\\# not a heading, 2\\*3, \\[x\\]')
    const md = blocksToMarkdown(blocks)
    expect(markdownToBlocks(md)).toEqual(blocks)
    expect(md).toBe('\\# not a heading, 2\\*3, \\[x\\]\n')
  })

  it('writes bold italic so it reads back', () => {
    const blocks = markdownToBlocks('**_both_** and ***triple***')
    expect(markdownToBlocks(blocksToMarkdown(blocks))).toEqual(blocks)
  })

  it('degrades a block it did not write to its text', () => {
    expect(
      blocksToMarkdown([
        {
          type: 'paragraph',
          content: [
            text('see '),
            { type: 'mention', props: { entityId: 'x', label: 'Acme' } },
          ],
          children: [],
        },
        { type: 'table', content: null, children: [] },
      ]),
    ).toBe('see Acme\n')
  })
})

describe('noteBodyFromMarkdown → the editor', () => {
  it('opens populated in BlockNote, and bodyMd is the markdown of what opened', () => {
    const { bodyJson, bodyMd } = noteBodyFromMarkdown(SUMMARY)
    const editor = BlockNoteEditor.create({
      initialContent: editorBlocks(bodyJson),
    })
    const opened = stored(editor.document)

    // What the editor holds is exactly what was stored, ids aside.
    expect(withoutIds(opened)).toEqual(stored(bodyJson))
    // And the stored markdown is the markdown of that document.
    expect(blocksToMarkdown(opened)).toBe(bodyMd)
    expect(bodyMd).toContain('(acme\\_dd.pdf, p.12)')
  })
})

/** SPA-91: the key-terms note is a term / value / citation table. */
const TERMS = [
  'Read from the term sheet.',
  '',
  '| Term | Value | Citation |',
  '| --- | --- | --- |',
  '| Liquidation preference | 1x **non-participating** | term\\_sheet.pdf, p.2 |',
  '| Pro-rata | Major investors \\| above $1M | term\\_sheet.pdf, p.3 |',
  '| Governing law | England |',
].join('\n')

const C = { ...P, colspan: 1, rowspan: 1 }
const cell = (...content: Array<ReturnType<typeof text>>) => ({
  type: 'tableCell',
  props: C,
  content,
})

describe('tables', () => {
  it('reads a pipe table into one BlockNote table, header first, rows padded', () => {
    const blocks = markdownToBlocks(TERMS)
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table'])
    expect(blocks[1]).toEqual({
      type: 'table',
      props: { textColor: 'default' },
      content: {
        type: 'tableContent',
        columnWidths: [null, null, null],
        headerRows: 1,
        rows: [
          {
            cells: [
              cell(text('Term')),
              cell(text('Value')),
              cell(text('Citation')),
            ],
          },
          {
            cells: [
              cell(text('Liquidation preference')),
              cell(text('1x '), text('non-participating', { bold: true })),
              cell(text('term_sheet.pdf, p.2')),
            ],
          },
          {
            cells: [
              cell(text('Pro-rata')),
              cell(text('Major investors | above $1M')),
              cell(text('term_sheet.pdf, p.3')),
            ],
          },
          {
            cells: [cell(text('Governing law')), cell(text('England')), cell()],
          },
        ],
      },
      children: [],
    })
  })

  it('leaves a piped line with no delimiter row as paragraph text', () => {
    expect(markdownToBlocks('a | b\nc | d').map((b) => b.type)).toEqual([
      'paragraph',
    ])
  })

  it('writes a table back as GFM that reads back as itself', () => {
    const blocks = markdownToBlocks(TERMS)
    const md = blocksToMarkdown(blocks)
    expect(md).toContain('| Term | Value | Citation |\n| --- | --- | --- |\n')
    expect(md).toContain('| Major investors \\| above $1M |')
    expect(markdownToBlocks(md)).toEqual(blocks)
  })

  it('opens in BlockNote as itself, and bodyMd is the markdown of what opened', () => {
    const { bodyJson, bodyMd } = noteBodyFromMarkdown(TERMS)
    const editor = BlockNoteEditor.create({
      initialContent: editorBlocks(bodyJson),
    })
    const opened = stored(editor.document)
    expect(withoutIds(opened)).toEqual(stored(bodyJson))
    expect(blocksToMarkdown(opened)).toBe(bodyMd)
  })
})
