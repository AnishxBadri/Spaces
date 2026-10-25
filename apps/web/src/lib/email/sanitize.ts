import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'

/**
 * An email's HTML part → the `srcdoc` the viewer's sandboxed iframe shows.
 * Server-only: DOMPurify over jsdom, never shipped to the browser.
 * - Scripts, forms, embeds and event handlers are gone; a Content-Security-
 *   Policy inside the document refuses every load but `data:` as a second
 *   wall, so a tracking pixel the sanitizer missed still never fetches.
 * - `cid:` images arrive as `data:` URIs (the parser inlines them) and stay.
 *   Every other image is a dithered placeholder at its own size; only the
 *   remote ones are counted, never a `cid:` whose part is missing.
 * - Web links open in a new tab with `rel="noopener"`; a `mailto:` is its
 *   text while no composer exists; any other link loses its target.
 */

export type SanitizedEmail = {
  srcdoc: string
  /** Images that would have loaded from the network, none of which did. */
  remoteImages: number
}

const FORBID_TAGS = [
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'iframe',
  'frame',
  'object',
  'embed',
  'base',
  'meta',
  'link',
  'audio',
  'video',
  'source',
  'track',
]

const FORBID_ATTR = ['background', 'srcset', 'action', 'formaction', 'ping']

/** Every load the document may make: inline styles and `data:` only. */
const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"

/**
 * The placeholder a remote image becomes: a 2px ordered dot pattern that
 * tiles at the image's box. Literal colours, because the iframe cannot read
 * the app's custom properties.
 */
const DITHER_SRC = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><defs><pattern id="d" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="#8a8984"/><rect x="2" y="2" width="1" height="1" fill="#8a8984"/></pattern></defs><rect width="100%" height="100%" fill="#f4f3ef"/><rect width="100%" height="100%" fill="url(#d)"/></svg>',
)}`

const BASE_STYLE = [
  'html,body{margin:0;padding:0;background:#fff}',
  'body{font:14px/20px system-ui,-apple-system,"Segoe UI",sans-serif;color:oklch(24% 0.012 155);overflow-wrap:anywhere}',
  'img{max-width:100%}',
  'a{color:inherit}',
].join('')

/** `url(…)` that is not `data:`, and `@import`: both would fetch. */
const REMOTE_URL = /url\(\s*(?!['"]?\s*data:)[^)]*\)/gi
const IMPORT = /@import[^;]*;?/gi

export function stripRemoteCss(css: string): string {
  return css.replace(IMPORT, '').replace(REMOTE_URL, 'none')
}

// Never name a module-level binding `window`: the devtools vite plugin
// prepends code that reads the global `window` into this same module scope,
// and a shadowing `let` puts that read in the temporal dead zone.
let dom: JSDOM['window'] | null = null
function domWindow(): JSDOM['window'] {
  dom ??= new JSDOM('').window
  return dom
}

export function sanitizeEmailHtml(html: string): SanitizedEmail {
  const win = domWindow()
  const purify = createDOMPurify(win)
  const root = purify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
  })
  // The whole document comes back as its `<html>` element.
  if (!(root instanceof win.Element)) return { srcdoc: '', remoteImages: 0 }
  const doc = root

  let remoteImages = 0
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    if (/^data:image\//i.test(src)) continue
    img.setAttribute('src', DITHER_SRC)
    // A `cid:` left unresolved names a part the MIME lacks: nothing remote.
    if (/^cid:/i.test(src.trim())) {
      img.setAttribute('data-missing-part', '')
      continue
    }
    if (src.trim() !== '') remoteImages += 1
    img.setAttribute('data-remote-image', '')
  }

  for (const a of Array.from(doc.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    } else if (/^mailto:/i.test(href)) {
      // No composer yet: the address reads as plain text.
      a.replaceWith(...Array.from(a.childNodes))
    } else {
      a.removeAttribute('href')
      a.removeAttribute('target')
    }
  }

  for (const el of Array.from(doc.querySelectorAll('[style]')))
    el.setAttribute('style', stripRemoteCss(el.getAttribute('style') ?? ''))
  const styles = Array.from(doc.querySelectorAll('style')).map((s) => {
    const css = stripRemoteCss(s.textContent)
    s.remove()
    return css
  })

  const body = doc.querySelector('body')?.innerHTML ?? ''
  const srcdoc = [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<style>${BASE_STYLE}</style>`,
    ...styles.map((css) => `<style>${css.replace(/<\//g, '<\\/')}</style>`),
    `</head><body>${body}</body></html>`,
  ].join('')
  return { srcdoc, remoteImages }
}
