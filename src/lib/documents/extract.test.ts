import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { detectFormat, extractDocumentText } from './extract'

/**
 * OOXML fixtures are built here rather than committed as binaries: the
 * parsers are regex-over-XML, so the XML shape *is* the thing under test,
 * and a checked-in .pptx hides it.
 */
function ooxml(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, xml]) => [path, strToU8(xml)]),
    ),
  )
}

function slide(...runs: Array<string>): string {
  return `<?xml version="1.0"?><p:sld xmlns:a="x"><p:cSld><p:spTree>${runs
    .map((r) => `<a:p><a:r><a:t>${r}</a:t></a:r></a:p>`)
    .join('')}</p:spTree></p:cSld></p:sld>`
}

describe('detectFormat', () => {
  it('prefers the extension — browsers mislabel real decks', () => {
    expect(detectFormat('deck.pptx', 'application/octet-stream')).toBe('pptx')
  })
  it('falls back to mime when the name has no extension', () => {
    expect(detectFormat('attachment', 'application/pdf')).toBe('pdf')
  })
  it('treats any text/* as text', () => {
    expect(detectFormat('notes', 'text/x-rst')).toBe('text')
  })
  it('returns null when neither says anything useful', () => {
    expect(detectFormat('scan', 'image/png')).toBeNull()
    expect(detectFormat(null, null)).toBeNull()
  })
})

describe('extractDocumentText — routing', () => {
  it('reports unsupported (not failed) for a format with no extractor', async () => {
    const out = await extractDocumentText({
      bytes: strToU8('binary'),
      filename: 'scan.png',
      mime: 'image/png',
    })
    expect(out.status).toBe('unsupported')
  })

  it('reports unsupported for a supported format that holds no text', async () => {
    const out = await extractDocumentText({
      bytes: strToU8('   \n\n  '),
      filename: 'empty.txt',
    })
    expect(out).toMatchObject({ status: 'unsupported' })
  })

  it('reports failed when the bytes are broken, not unsupported', async () => {
    const out = await extractDocumentText({
      bytes: strToU8('not a zip'),
      filename: 'deck.pptx',
    })
    expect(out.status).toBe('failed')
  })
})

describe('pptx', () => {
  it('reads slides in numeric order, not lexical', async () => {
    const bytes = ooxml({
      'ppt/slides/slide1.xml': slide('First'),
      'ppt/slides/slide2.xml': slide('Second'),
      'ppt/slides/slide10.xml': slide('Tenth'),
    })
    const out = await extractDocumentText({ bytes, filename: 'deck.pptx' })
    expect(out.status).toBe('done')
    const text = out.status === 'done' ? out.text : ''
    expect(text.indexOf('Second')).toBeLessThan(text.indexOf('Tenth'))
    expect(text).toContain('[Slide 10]')
  })

  it('captures speaker notes — the numbers often live there', async () => {
    const bytes = ooxml({
      'ppt/slides/slide1.xml': slide('Traction'),
      'ppt/notesSlides/notesSlide1.xml': slide('ARR is $1.2M as of March'),
    })
    const out = await extractDocumentText({ bytes, filename: 'deck.pptx' })
    expect(out.status === 'done' && out.text).toContain('ARR is $1.2M')
  })

  it('decodes XML entities in slide text', async () => {
    const bytes = ooxml({
      'ppt/slides/slide1.xml': slide('R&amp;D &lt;40% of spend&gt;'),
    })
    const out = await extractDocumentText({ bytes, filename: 'deck.pptx' })
    expect(out.status === 'done' && out.text).toContain('R&D <40% of spend>')
  })
})

describe('xlsx', () => {
  const workbook = ooxml({
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="Cap Table (post)" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Series </t><t>A</t></si><si><t>Founders</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row><c r="A2"><v>4200000</v></c><c r="B2" t="inlineStr"><is><t>62.5%</t></is></c></row>' +
      '<row><c r="A3"/></row>' +
      '</sheetData></worksheet>',
  })

  it('uses the real sheet name — the most searchable string in the file', async () => {
    const out = await extractDocumentText({
      bytes: workbook,
      filename: 'captable.xlsx',
    })
    expect(out.status === 'done' && out.text).toContain('[Cap Table (post)]')
  })

  it('concatenates rich-text runs inside one shared string', async () => {
    const out = await extractDocumentText({
      bytes: workbook,
      filename: 'captable.xlsx',
    })
    expect(out.status === 'done' && out.text).toContain('Series A')
  })

  it('keeps raw numbers and inline strings, drops fully empty rows', async () => {
    const out = await extractDocumentText({
      bytes: workbook,
      filename: 'captable.xlsx',
    })
    const text = out.status === 'done' ? out.text : ''
    expect(text).toContain('4200000\t62.5%')
    expect(text.trim().split('\n')).toHaveLength(3) // title + 2 rows
  })
})

describe('plain text', () => {
  it('passes through and collapses runaway whitespace', async () => {
    const out = await extractDocumentText({
      bytes: strToU8('Thesis:   launch   cost\n\n\n\n\nbelow $1000/kg\n'),
      filename: 'thesis.md',
    })
    expect(out.status === 'done' && out.text).toBe(
      'Thesis: launch cost\n\nbelow $1000/kg',
    )
  })
})
