import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractDocumentText } from '../documents/extract'
import {
  GridRefused,
  MAX_IMPORT_ROWS,
  RowCapExceeded,
  isDateFormat,
  readGrid,
  serialToIsoDate,
  sniffDelimiter,
} from './read'

/**
 * Every fixture is built here from strings — CSV as text, xlsx as a zip of
 * hand-written parts — so no binary is committed and the case under test
 * (a quoted newline, a date numFmt) is readable in the fixture itself.
 */

const csv = (text: string) => strToU8(text)

function xlsx(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, xml]) => [path, strToU8(xml)]),
    ),
  )
}

const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '</Types>'

/**
 * Two sheets, listed in the workbook in the opposite order to their part
 * numbers, so tab order is read from the workbook and not from the zip.
 * cellXfs: 0 = General, 1 = built-in 14 (m/d/yyyy), 2 = custom 164
 * (dd/mm/yyyy), 3 = custom 165 (#,##0.00 — a number, not a date).
 */
function workbook(options: { date1904?: boolean } = {}): Uint8Array {
  return xlsx({
    '[Content_Types].xml': CONTENT_TYPES,
    'xl/workbook.xml':
      '<workbook xmlns:r="r">' +
      (options.date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>') +
      '<sheets>' +
      '<sheet name="Deals &amp; Rounds" sheetId="1" r:id="rId2"/>' +
      '<sheet name="Marks" sheetId="2" r:id="rId1"/>' +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships>' +
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/>' +
      '</Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Company</t></si><si><t>Closed</t></si><si><t>Amount</t></si>' +
      '<si><r><t>Acme</t></r><r><t xml:space="preserve"> </t></r><r><t>Robotics</t></r></si>' +
      '<si><t>Mark date</t></si><si><t>Value</t></si></sst>',
    'xl/styles.xml':
      '<styleSheet>' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>' +
      '<numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>' +
      '<cellXfs count="4"><xf numFmtId="0" fontId="0"/><xf numFmtId="14" fontId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="164" fontId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0"/></cellXfs>' +
      '</styleSheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>45000</v></c><c r="C2"><v>45000</v></c></row>' +
      // B3 is absent, as xlsx writes an empty cell: C3 must stay in column C.
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Beta</t></is></c><c r="B3" s="1"/><c r="C3" s="3"><v>1250.5</v></c></row>' +
      '<row r="4"/>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>4</v></c><c r="B1" t="s"><v>5</v></c></row>' +
      '<row r="2"><c r="A2" s="2"><v>45000.75</v></c><c r="B2" t="b"><v>1</v></c></row>' +
      '</sheetData></worksheet>',
  })
}

describe('readGrid — CSV', () => {
  it('keeps a field with a comma, a doubled quote and an embedded newline in one cell', () => {
    const { sheets } = readGrid(
      csv(
        'Company,Notes,Amount\n"Acme, Inc.","Said ""yes""\non the call",100\nBeta,plain,200\n',
      ),
      'deals.csv',
    )
    expect(sheets).toHaveLength(1)
    expect(sheets[0].rows).toEqual([
      ['Company', 'Notes', 'Amount'],
      ['Acme, Inc.', 'Said "yes"\non the call', '100'],
      ['Beta', 'plain', '200'],
    ])
  })

  it('names the one sheet after the file', () => {
    const { sheets } = readGrid(csv('a,b\n1,2\n'), 'uploads/Portfolio 2024.csv')
    expect(sheets[0].name).toBe('Portfolio 2024')
  })

  it('never lets a UTF-8 BOM into the first header', () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...csv('Company,Amount\nAcme,1\n'),
    ])
    const { sheets } = readGrid(bytes, 'bom.csv')
    expect(sheets[0].rows[0][0]).toBe('Company')
    expect(sheets[0].rows[0][0].charCodeAt(0)).toBe(67)
    expect(sheets[0].headerRow).toBe(0)
  })

  it('reads CRLF and LF files, embedded newlines included, as identical grids', () => {
    const lf = 'Company,Notes\n"Acme","line one\nline two"\nBeta,x\n'
    const crlf = lf.replace(/\n/g, '\r\n')
    expect(readGrid(csv(crlf), 'a.csv')).toEqual(readGrid(csv(lf), 'a.csv'))
  })

  it('parses a semicolon-delimited European export with no configuration', () => {
    const { sheets } = readGrid(
      csv(
        'Firma;Betrag;Datum\r\nAcme GmbH;1.250,50;15.03.2023\r\n"Beta; AG";"2,5";01.04.2023\r\n',
      ),
      'export.csv',
    )
    expect(sheets[0].rows).toEqual([
      ['Firma', 'Betrag', 'Datum'],
      ['Acme GmbH', '1.250,50', '15.03.2023'],
      ['Beta; AG', '2,5', '01.04.2023'],
    ])
  })

  it('sniffs a tab-delimited file named .csv, and reads .tsv as tabs', () => {
    const text = 'Company\tAmount\tNotes, if any\nAcme\t1,000\tok\n'
    const row = ['Acme', '1,000', 'ok']
    expect(readGrid(csv(text), 'x.csv').sheets[0].rows[1]).toEqual(row)
    expect(readGrid(csv(text), 'x.tsv').sheets[0].rows[1]).toEqual(row)
    // A tie on the header line (one tab, one comma) reads as comma — which
    // is why a .tsv does not sniff.
    const tie = 'Company\tAmount, USD\nAcme\t1,000\n'
    expect(readGrid(csv(tie), 'x.tsv').sheets[0].rows[1]).toEqual([
      'Acme',
      '1,000',
    ])
  })

  it('reads the delimiter off the header line, ignoring quoted ones', () => {
    expect(sniffDelimiter('a,b,c\n1;2;3;4;5\n')).toBe(',')
    expect(sniffDelimiter('\n"x;y;z",b,c\n')).toBe(',')
    expect(sniffDelimiter('Name;Amount (EUR, net);Date\n')).toBe(';')
    expect(sniffDelimiter('single\n')).toBe(',')
  })

  it('pads ragged rows to a rectangle and drops blank lines', () => {
    const { sheets } = readGrid(csv('a,b,c\n1\n\n , ,\n2,3,4\n'), 'r.csv')
    expect(sheets[0].rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
      ['2', '3', '4'],
    ])
  })

  it('reads UTF-16LE, which Excel writes for "Unicode text"', () => {
    const text = 'Company\tAmount\nZürich AG\t5\n'
    const body = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) body[i * 2] = text.charCodeAt(i)
    const { sheets } = readGrid(new Uint8Array([0xff, 0xfe, ...body]), 'u.txt')
    expect(sheets[0].rows[1]).toEqual(['Zürich AG', '5'])
  })
})

describe('readGrid — header detection', () => {
  it('skips a title row and a row with duplicate cells', () => {
    const { sheets } = readGrid(
      csv(
        'Portfolio — Q3,,\nName,name ,Amount\nCompany,Stage,Amount\nAcme,Seed,1\n',
      ),
      'h.csv',
    )
    expect(sheets[0].headerRow).toBe(2)
  })

  it('is null when no row qualifies', () => {
    const { sheets } = readGrid(csv('a,,c\n1,,3\n'), 'n.csv')
    expect(sheets[0].headerRow).toBeNull()
  })
})

describe('readGrid — xlsx', () => {
  const { sheets } = readGrid(workbook(), 'portfolio.xlsx')
  const deals = sheets[0]
  const marks = sheets[1]

  it('returns one entry per sheet, in tab order, under the real names', () => {
    expect(sheets.map((s) => s.name)).toEqual(['Deals & Rounds', 'Marks'])
  })

  it('resolves shared strings, rich-text runs included, and inline strings', () => {
    expect(deals.rows[0]).toEqual(['Company', 'Closed', 'Amount'])
    expect(deals.rows[1][0]).toBe('Acme Robotics')
    expect(deals.rows[2][0]).toBe('Beta')
    expect(deals.headerRow).toBe(0)
  })

  it('turns a date-formatted serial into YYYY-MM-DD and leaves a plain number alone', () => {
    // B2 carries style 1 (numFmtId 14); C2 is the same 45000 in General.
    expect(deals.rows[1][1]).toBe('2023-03-15')
    expect(deals.rows[1][2]).toBe('45000')
    // A #,##0.00 custom format is a number, not a date.
    expect(deals.rows[2][2]).toBe('1250.5')
  })

  it('keeps a cell after a gap in its own column', () => {
    expect(deals.rows[2]).toEqual(['Beta', '', '1250.5'])
    expect(deals.rows).toHaveLength(3)
  })

  it('reads a custom dd/mm/yyyy format as a date, dropping the time of day', () => {
    expect(marks.rows[1]).toEqual(['2023-03-15', 'TRUE'])
  })

  it('counts from 1904 when the workbook says so', () => {
    const grid = readGrid(workbook({ date1904: true }), 'mac.xlsx')
    expect(grid.sheets[0].rows[1][1]).toBe('2027-03-16')
  })

  it('is the grid extract.ts turns into search text', async () => {
    const out = await extractDocumentText({
      bytes: workbook(),
      filename: 'portfolio.xlsx',
    })
    expect(out.status === 'done' && out.text).toBe(
      '[Deals & Rounds]\nCompany\tClosed\tAmount\n' +
        'Acme Robotics\t2023-03-15\t45000\nBeta\t\t1250.5\n\n' +
        '[Marks]\nMark date\tValue\n2023-03-15\tTRUE',
    )
  })
})

describe('readGrid — format choice', () => {
  it('reads a workbook by its content even when it is named .csv', () => {
    const { sheets } = readGrid(workbook(), 'export.csv')
    expect(sheets.map((s) => s.name)).toEqual(['Deals & Rounds', 'Marks'])
  })

  it('reads delimited text with no extension at all', () => {
    const { sheets } = readGrid(csv('a;b\n1;2\n'), 'download')
    expect(sheets[0]).toEqual({
      name: 'download',
      headerRow: 0,
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    })
  })

  it('refuses a legacy .xls, a fake .xlsx and a binary by name', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    expect(() => readGrid(ole, 'old.xls')).toThrow(/old\.xls is a legacy Excel/)
    expect(() => readGrid(csv('a,b'), 'fake.xlsx')).toThrow(GridRefused)
    expect(() => readGrid(new Uint8Array([1, 0, 2, 0]), 'blob.bin')).toThrow(
      /blob\.bin is not a spreadsheet/,
    )
  })

  it('refuses a zip with no worksheets', () => {
    const zip = xlsx({ 'word/document.xml': '<w:document/>' })
    expect(() => readGrid(zip, 'memo.xlsx')).toThrow(
      /memo\.xlsx contains no worksheets/,
    )
  })
})

describe('readGrid — row cap', () => {
  const file = (dataRows: number) =>
    csv(
      'Company,Amount\n' +
        Array.from({ length: dataRows }, (_, i) => `Co ${i},${i}`).join('\n'),
    )

  it('takes exactly the cap', () => {
    const { sheets } = readGrid(file(MAX_IMPORT_ROWS), 'big.csv')
    expect(sheets[0].rows).toHaveLength(MAX_IMPORT_ROWS + 1)
  })

  it('refuses one row more by name with its row count, never truncating', () => {
    let caught: unknown
    try {
      readGrid(file(MAX_IMPORT_ROWS + 1), 'huge.csv')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RowCapExceeded)
    if (!(caught instanceof RowCapExceeded)) return
    expect(caught.filename).toBe('huge.csv')
    expect(caught.rows).toBe(20_001)
    expect(caught.message).toContain('huge.csv has 20,001 data rows')
  })
})

describe('date formats', () => {
  it('knows a date format code from a number or a time', () => {
    expect(isDateFormat('dd/mm/yyyy')).toBe(true)
    expect(isDateFormat('mmm-yy')).toBe(true)
    expect(isDateFormat('[$-409]mmmm d, yyyy;@')).toBe(true)
    expect(isDateFormat('yyyy-mm-dd hh:mm')).toBe(true)
    expect(isDateFormat('#,##0.00')).toBe(false)
    expect(isDateFormat('[h]:mm:ss')).toBe(false)
    expect(isDateFormat('hh:mm')).toBe(false)
    expect(isDateFormat('0 "days"')).toBe(false)
    expect(isDateFormat('[Red]#,##0;[Blue](#,##0)')).toBe(false)
  })

  it('converts serials in both systems', () => {
    expect(serialToIsoDate('45000')).toBe('2023-03-15')
    expect(serialToIsoDate('45000.9999999999')).toBe('2023-03-16')
    expect(serialToIsoDate('1')).toBe('1900-01-01')
    expect(serialToIsoDate('61')).toBe('1900-03-01')
    expect(serialToIsoDate('0', true)).toBe('1904-01-01')
    expect(serialToIsoDate('')).toBeNull()
    expect(serialToIsoDate('-3')).toBeNull()
    expect(serialToIsoDate('1e12')).toBeNull()
  })
})
