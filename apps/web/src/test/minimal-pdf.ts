/**
 * A one-page uncompressed PDF with a real text layer, built by hand.
 *
 * Three test files want PDF bytes for three different reasons — intake
 * measuring a digest, `document.extract` running pdf.js over a text layer,
 * and (docsurf-10b) the clip job hashing a PDF response — and an extraction
 * assertion is only worth making against bytes pdf.js actually parses. A
 * checked-in binary fixture would answer none of those questions any better
 * and could not be read in a diff; a one-page PDF with a correct xref table
 * is small enough to write out, so it is written out here **once** rather
 * than copied into each file that needs it.
 *
 * `latin1`, not utf-8: the xref table stores byte offsets, and a multi-byte
 * character anywhere in `phrase` would make every offset after it wrong.
 */
export function minimalPdf(phrase: string): Buffer {
  const content = `BT /F1 18 Tf 72 700 Td (${phrase}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: Array<number> = []
  objects.forEach((object, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}
