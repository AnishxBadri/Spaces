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

/**
 * A minimal, valid PDF: one page per entry, each drawing its lines in
 * Helvetica — or nothing at all for `null`, which is a page with no text
 * layer (what a scanned page looks like to a text extractor). Built by hand
 * for the same reason as the OOXML fixtures, and the xref offsets are real
 * so pdf.js reads it without falling back to reconstruction. The type is
 * 1pt because pdf.js drops glyphs that fall off the page: at 1pt a line
 * holds ~900 characters and a page ~500 lines, enough to fill the column.
 */
function pdf(pages: Array<Array<string> | null>): Uint8Array {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
  const objects: Array<string> = []
  const pageIds = pages.map((_, i) => 4 + i * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pages.forEach((lines, i) => {
    const pageId = pageIds[i]
    const stream = lines
      ? `BT /F1 1 Tf 1.2 TL 36 756 Td ${lines.map((l) => `(${escape(l)}) Tj T*`).join(' ')} ET`
      : '0 0 1 rg 72 72 200 200 re f'
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`
    objects[pageId + 1] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })

  let body = '%PDF-1.4\n'
  const offsets: Array<number> = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return strToU8(body)
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

describe('pdf', () => {
  it('marks each page in the shape pptx marks each slide', async () => {
    const bytes = pdf([
      ['Vayu Orbital', 'Seed round'],
      ['Traction', 'ARR is $1.2M'],
      ['Team'],
    ])
    const out = await extractDocumentText({ bytes, filename: 'deck.pdf' })
    expect(out).toMatchObject({ status: 'done', format: 'pdf' })
    const text = out.status === 'done' ? out.text : ''
    expect(text).toMatch(
      /^\[Page 1\]\nVayu Orbital\nSeed round\n\n\[Page 2\]\nTraction\nARR is \$1\.2M\n\n\[Page 3\]\nTeam$/,
    )
  })

  it('still marks a one-page PDF', async () => {
    const out = await extractDocumentText({
      bytes: pdf([['Term sheet']]),
      filename: 'terms.pdf',
    })
    expect(out.status === 'done' && out.text).toBe('[Page 1]\nTerm sheet')
  })

  it('keeps real page numbers across a page with no text layer', async () => {
    const out = await extractDocumentText({
      bytes: pdf([['Cover'], null, ['Market']]),
      filename: 'deck.pdf',
    })
    const text = out.status === 'done' ? out.text : ''
    expect(text).toContain('[Page 3]\nMarket')
    expect(text).not.toContain('[Page 2]')
  })

  it('reports a PDF with no text layer as unsupported, not a column of markers', async () => {
    const out = await extractDocumentText({
      bytes: pdf([null, null, null]),
      filename: 'scan.pdf',
    })
    expect(out).toMatchObject({ status: 'unsupported', format: 'pdf' })
  })

  it('does not let whitespace normalization fold the markers', async () => {
    const out = await extractDocumentText({
      bytes: pdf([['Moat:    patents', '', '', ''], ['   Ask   ']]),
      filename: 'deck.pdf',
    })
    expect(out.status === 'done' && out.text).toBe(
      '[Page 1]\nMoat: patents\n\n[Page 2]\nAsk',
    )
  })

  it('truncates after the markers are in, so a long deck cannot blow the column', async () => {
    // ~450k characters a page: four and a bit pages fill 2,000,000.
    const page = Array.from({ length: 500 }, () => 'x'.repeat(900))
    const out = await extractDocumentText({
      bytes: pdf(Array.from({ length: 6 }, () => page)),
      filename: 'long.pdf',
    })
    const text = out.status === 'done' ? out.text : ''
    expect(text).toHaveLength(2_000_000)
    expect(text.startsWith('[Page 1]\n')).toBe(true)
    expect(text).toContain('\n\n[Page 5]\n')
    expect(text).not.toContain('[Page 6]')
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
