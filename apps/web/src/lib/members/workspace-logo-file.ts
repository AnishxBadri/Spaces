import { sniffPicture } from '@spaces/core/enrichment/picture'
import type { PictureType } from '@spaces/core/enrichment/picture'

/**
 * What a workspace logo file may be, judged by its bytes: a raster image or
 * a plain SVG, at most 1 MB. Pure, so the upload and the logo route agree.
 * - An SVG is refused whole, never stripped, when it could run or fetch
 *   anything: no scripts or embedded content, no event handlers, no
 *   reference outside the file, no entity declarations or escapes.
 * - It is also only drawn through `<img>` and served under a sandbox CSP,
 *   so this check is the first of three locks, not the only one.
 */

export const LOGO_MAX_BYTES = 1024 * 1024

export type LogoType = PictureType | 'image/svg+xml'

export const LOGO_TOO_LARGE = 'The logo is larger than 1 MB'
export const LOGO_NOT_AN_IMAGE =
  'The logo must be a PNG, JPEG, GIF, WebP or SVG image'

/** Elements that run, embed or animate something; refused in any namespace. */
const UNSAFE_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'image',
  'feimage',
  'handler',
  'listener',
  'set',
  'animate',
  'animatemotion',
  'animatetransform',
  'animatecolor',
])

/** A prolog (declarations, comments, a DOCTYPE), then `<svg` as the root. */
const SVG_HEAD =
  /^(?:<\?[^>]*>|<!--[\s\S]*?-->|<!doctype(?:[^[>]|\[[\s\S]*?\])*>|\s)*<svg[\s>]/i

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** The SVG's text when the bytes are one, else null. */
export const svgText = (bytes: Uint8Array): string | null => {
  const text = decodeUtf8(bytes)
  if (text === null) return null
  const body = text.trimStart()
  return SVG_HEAD.test(body) ? body : null
}

/** Why this SVG cannot be a logo, or null when it is plain. */
export const svgRefusal = (svg: string): string | null => {
  if (/<!entity|<!doctype[^>]*\[|&#|\\/i.test(svg))
    return 'entity declarations or escapes'
  if (/<\?/.test(svg.replace(/^<\?xml[^>]*\?>/i, '')))
    return 'a processing instruction'
  for (const [, name] of svg.matchAll(/<\/?([a-z_][\w:.-]*)/gi)) {
    const local = name.toLowerCase().split(':').at(-1) ?? ''
    if (UNSAFE_ELEMENTS.has(local)) return 'a script or embedded content'
  }
  if (/[\s"'/]on[a-z]+\s*=/i.test(svg)) return 'an event handler'
  if (/javascript:|@import/i.test(svg)) return 'an external reference'
  for (const [, , value] of svg.matchAll(
    /[\s"'](?:[\w.-]+:)?href\s*=\s*(["'])([\s\S]*?)\1/gi,
  ))
    if (!value.trim().startsWith('#')) return 'an external reference'
  for (const [, target] of svg.matchAll(/url\(\s*['"]?\s*([^)'"\s]*)/gi))
    if (!target.startsWith('#')) return 'an external reference'
  return null
}

/** The logo's type, or why it is refused: size first, then the bytes. */
export const judgeLogo = (
  bytes: Uint8Array,
):
  | { readonly ok: true; readonly type: LogoType }
  | { readonly ok: false; readonly message: string } => {
  if (bytes.length > LOGO_MAX_BYTES)
    return { ok: false, message: LOGO_TOO_LARGE }
  const raster = sniffPicture(bytes)
  if (raster !== null) return { ok: true, type: raster }
  const svg = svgText(bytes)
  if (svg === null) return { ok: false, message: LOGO_NOT_AN_IMAGE }
  const refusal = svgRefusal(svg)
  return refusal === null
    ? { ok: true, type: 'image/svg+xml' }
    : {
        ok: false,
        message: `This SVG carries ${refusal}; export a plain SVG or a PNG`,
      }
}
