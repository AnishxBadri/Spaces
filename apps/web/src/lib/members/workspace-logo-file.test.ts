import { describe, expect, it } from 'vitest'
import {
  LOGO_MAX_BYTES,
  LOGO_NOT_AN_IMAGE,
  LOGO_TOO_LARGE,
  judgeLogo,
} from './workspace-logo-file'

/** What a logo file may be: raster or plain SVG, at most 1 MB. */

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (size = 64) => {
  const bytes = new Uint8Array(size)
  bytes.set(PNG)
  return bytes
}
const text = (s: string) => new TextEncoder().encode(s)

const PLAIN_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: a design tool -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient>
    <style>.a { fill: url(#g); }</style>
  </defs>
  <path class="a" d="M0 0h10v10z"/>
  <use xlink:href="#g"/>
</svg>`

const svgWith = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`

describe('judgeLogo', () => {
  it('takes a PNG by its bytes', () => {
    expect(judgeLogo(png())).toEqual({ ok: true, type: 'image/png' })
  })

  it('takes a plain SVG, gradients and internal references included', () => {
    expect(judgeLogo(text(PLAIN_SVG))).toEqual({
      ok: true,
      type: 'image/svg+xml',
    })
  })

  it('refuses a 3 MB file for its size, before its type', () => {
    expect(judgeLogo(png(3 * 1024 * 1024))).toEqual({
      ok: false,
      message: LOGO_TOO_LARGE,
    })
    expect(judgeLogo(png(LOGO_MAX_BYTES)).ok).toBe(true)
  })

  it('refuses a PDF as not an image', () => {
    expect(judgeLogo(text('%PDF-1.7\n1 0 obj\n'))).toEqual({
      ok: false,
      message: LOGO_NOT_AN_IMAGE,
    })
  })

  it.each([
    ['a script', svgWith('<script>alert(1)</script>')],
    ['a namespaced script', svgWith('<svg:script>alert(1)</svg:script>')],
    ['foreign HTML', svgWith('<foreignObject><div/></foreignObject>')],
    ['an embedded image', svgWith('<image href="data:image/png;base64,AA"/>')],
    ['an animation', svgWith('<set attributeName="href" to="#x"/>')],
    ['an event handler', svgWith('<rect onload="alert(1)"/>')],
    ['an event handler on the root', '<svg onclick="x()"></svg>'],
    ['an external href', svgWith('<use href="https://evil.example/a#b"/>')],
    ['an external xlink', svgWith('<a xlink:href="javascript:x()"/>')],
    ['an external url()', svgWith('<rect style="fill:url(https://e.x/a)"/>')],
    ['an import', svgWith('<style>@import "https://e.x/a.css";</style>')],
    ['an escape', svgWith('<style>.a{fill:u\\72l(https://e.x)}</style>')],
    ['a character reference', svgWith('<use href="&#106;s:x"/>')],
    [
      'an entity',
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "b">]><svg>&a;</svg>',
    ],
    [
      'a stylesheet instruction',
      '<?xml version="1.0"?><?xml-stylesheet href="https://e.x/a.css"?><svg></svg>',
    ],
  ])('refuses an SVG carrying %s, naming why', (_, svg) => {
    const judged = judgeLogo(text(svg))
    expect(judged.ok).toBe(false)
    expect(judged.ok ? '' : judged.message).toMatch(
      /^This SVG carries .+; export a plain SVG or a PNG$/,
    )
  })
})
