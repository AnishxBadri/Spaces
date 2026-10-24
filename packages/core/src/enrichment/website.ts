import { Context } from 'effect'
import type { Effect } from 'effect'
import { z } from 'zod'
import type { JobError } from '@spaces/sdk'
import { vocabularyProblem } from '@spaces/sdk/vocabulary'
import type { VocabularyKey } from '@spaces/sdk/vocabulary'
import type { Json } from '@spaces/db/json'
import type { JsonSchema } from '../ai/schema'
import type { ContextItem } from '../context/types'
import { PICTURE_KEYS } from './picture'

/**
 * The built-in Website source, pure half: a company's own pages
 * read to text, in two halves.
 * - The markup half needs no model: the meta description (else the title),
 *   the icon or share image as the logo, the profile links in the markup.
 * - The model half is the Extract lane's fixed schema over the page text; it
 *   answers only the keys the markup half left empty.
 * - No JavaScript runs: a page is its served HTML, read with regexes.
 * - A link or a logo is answered only when the page itself carries it, so
 *   a model cannot invent a profile URL.
 * - The logo is answered as `company.logo`, a picture key: the run fetches
 *   it and sets the record's picture when empty.
 */

/** The name the timeline and the where-from give the source. */
export const WEBSITE_NAME = 'Website'

/** The words a sensitive record's skip puts on the run's timeline line. */
export const WEBSITE_SENSITIVE = 'sensitive'

const FIELD_NAMES = [
  'description',
  'location',
  'linkedin',
  'twitter',
  'crunchbase',
  'blog',
] as const
type FieldName = (typeof FIELD_NAMES)[number]

/** Each schema field and the vocabulary key it answers. */
const FIELDS: { readonly [F in FieldName]: VocabularyKey } = {
  description: 'company.description',
  location: 'company.location',
  linkedin: 'company.linkedin',
  twitter: 'company.twitter',
  crunchbase: 'company.crunchbase',
  blog: 'company.blog',
}

/** The logo's key: a picture key, never linked to an attribute. */
export const LOGO_KEY: VocabularyKey = PICTURE_KEYS.company

/** The profile links only the markup half reads: the model schema has no field for them. */
const MARKUP_ONLY: ReadonlyArray<VocabularyKey> = [
  'company.facebook',
  'company.angellist',
]

/** The vocabulary keys the source can answer, the logo's among them. */
export const WEBSITE_KEYS: ReadonlyArray<VocabularyKey> = [
  ...FIELD_NAMES.map((name) => FIELDS[name]),
  ...MARKUP_ONLY,
  LOGO_KEY,
]

/** The keys the model half can answer. */
export const MODEL_KEYS: ReadonlyArray<VocabularyKey> = [
  ...FIELD_NAMES.map((name) => FIELDS[name]),
  LOGO_KEY,
]

/** The source's name on the run's timeline line, by the halves that ran. */
export const websiteLabel = (model: boolean): string =>
  `${WEBSITE_NAME} (${model ? 'markup + model' : 'markup'})`

/** The model half's name when a sensitive record skips it. */
export const WEBSITE_MODEL_NAME = `${WEBSITE_NAME} (model)`

/** A page's text is cut here before it reaches the model. */
const PAGE_TEXT_CHARS = 12_000
const MAX_LINKS = 150
const MAX_IMAGES = 12

/** One fetch the source makes, as its reader answers it. */
export type FetchedPage =
  | {
      readonly ok: true
      /** After every redirect. */
      readonly url: string
      readonly contentType: string | null
      readonly bytes: Uint8Array
    }
  | {
      readonly ok: false
      readonly reason: string
      /** The body passed the byte cap. */
      readonly tooLarge?: boolean
    }

/** Where the Extract lane goes at one sensitivity: nowhere usable, this box, or a cloud provider. */
export type ExtractRoute = 'unrouted' | 'local' | 'cloud'

/**
 * The source's two reads of the outside: a guarded page fetch and the
 * Extract lane's route. The worker's Live is the deck-link clip's fetch and
 * the AI router. The run fetches a record's picture through the same guard,
 * under its own lower byte cap.
 */
export class WebsiteReader extends Context.Service<
  WebsiteReader,
  {
    readonly fetch: (
      url: string,
      caps?: { readonly maxBytes: number },
    ) => Effect.Effect<FetchedPage>
    readonly extractRoute: (
      sensitivity: 'normal' | 'sensitive',
    ) => Effect.Effect<ExtractRoute, JobError>
  }
>()('spaces/core/WebsiteReader') {}

/** A page read to what the model is shown. */
export type Page = {
  readonly url: string
  readonly title: string | null
  readonly description: string | null
  readonly text: string
  readonly links: ReadonlyArray<{
    readonly href: string
    readonly text: string
  }>
  /** Logo candidates: logo images, touch icons, the share image. */
  readonly images: ReadonlyArray<string>
  /** The `<link rel=…icon>` images, a touch icon first; no SVG. */
  readonly icons: ReadonlyArray<string>
  /** The `og:image`, when the page names one. */
  readonly shareImage: string | null
}

const ENTITIES: { readonly [name: string]: string } = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const decodeEntities = (raw: string): string =>
  raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16)
      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })

const squash = (raw: string) => raw.replace(/\s+/g, ' ').trim()

const attrsOf = (tag: string): ReadonlyMap<string, string> => {
  const out = new Map<string, string>()
  for (const m of tag.matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/g,
  ))
    out.set(
      m[1].toLowerCase(),
      decodeEntities(m[2].replace(/^(["'])([\s\S]*)\1$/, '$2')),
    )
  return out
}

/** An absolute http(s) URL, or null. */
const absolute = (href: string, base: string): string | null => {
  try {
    const url = new URL(href.trim(), base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

const stripTags = (html: string) =>
  decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|section|article|tr|header|footer)>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )

const tidy = (raw: string) =>
  raw
    .split(/\n/)
    .map(squash)
    .filter((line) => line !== '')
    .join('\n')

/** Bytes as text; a page mis-declaring its encoding loses a character, not the read. */
export const decodePage = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: false }).decode(bytes)

/** Whether the response is an HTML page: by its type, else by its first bytes. */
export const isHtml = (contentType: string | null, body: string): boolean => {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'text/html' || type === 'application/xhtml+xml') return true
  if (type !== '') return false
  return /^\s*(<!doctype html|<html)/i.test(body)
}

/** The page read to its title, description, text, links and logo candidates. */
export const readPage = (html: string, url: string): Page => {
  const bare = html.replace(/<!--[\s\S]*?-->/g, '')
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(bare)
  const metas = [...bare.matchAll(/<meta\b([^>]*)>/gi)].map((m) =>
    attrsOf(m[1]),
  )
  const meta = (name: string) =>
    metas
      .find((a) => (a.get('name') ?? a.get('property'))?.toLowerCase() === name)
      ?.get('content') ?? null
  const description =
    meta('description') ?? meta('og:description') ?? meta('twitter:description')

  const links: Array<{ href: string; text: string }> = []
  const seen = new Set<string>()
  for (const m of bare.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = attrsOf(m[1])
    const href = absolute(attrs.get('href') ?? '', url)
    if (href === null || seen.has(href)) continue
    seen.add(href)
    const text = squash(stripTags(m[2])) || (attrs.get('aria-label') ?? '')
    links.push({ href, text: squash(text).slice(0, 80) })
  }

  const images: Array<string> = []
  const image = (src: string | undefined) => {
    const at = src === undefined ? null : absolute(src, url)
    if (at !== null && !images.includes(at)) images.push(at)
  }
  for (const m of bare.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = attrsOf(m[1])
    const said = ['src', 'alt', 'class', 'id']
      .map((k) => attrs.get(k) ?? '')
      .join(' ')
    if (/logo/i.test(said)) image(attrs.get('src'))
  }
  const touch: Array<string> = []
  const plain: Array<string> = []
  for (const m of bare.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = attrsOf(m[1])
    const rel = attrs.get('rel') ?? ''
    if (!/icon/i.test(rel)) continue
    image(attrs.get('href'))
    const at = absolute(attrs.get('href') ?? '', url)
    if (
      at === null ||
      /\.svg(\?|$)/i.test(at) ||
      /svg/i.test(attrs.get('type') ?? '')
    )
      continue
    ;(/apple-touch-icon/i.test(rel) ? touch : plain).push(at)
  }
  const ogImage = meta('og:image')
  image(ogImage ?? undefined)
  const shareImage = ogImage === null ? null : absolute(ogImage, url)

  const body = bare
    .replace(
      /<(head|script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi,
      ' ',
    )
    .replace(/<(script|style)\b[^>]*\/>/gi, ' ')
  return {
    url,
    title: title === null ? null : squash(decodeEntities(title[1])) || null,
    description: description === null ? null : squash(description) || null,
    text: tidy(stripTags(body)).slice(0, PAGE_TEXT_CHARS),
    links: links.slice(0, MAX_LINKS),
    images: images.slice(0, MAX_IMAGES),
    icons: [...new Set([...touch, ...plain])],
    shareImage,
  }
}

const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** The page's about page, when it links one on its own site. */
export const aboutLinkOf = (page: Page): string | null => {
  const site = siteOf(page.url)
  const home = new URL(page.url)
  for (const link of page.links) {
    if (siteOf(link.href) !== site) continue
    const target = new URL(link.href)
    if (target.pathname === home.pathname) continue
    if (
      /^\/(about|about-us|company|who-we-are|our-story)\/?$/i.test(
        target.pathname,
      ) ||
      /^about( us)?$/i.test(link.text)
    )
      return link.href
  }
  return null
}

/** One context item per page, in the order they were read. */
export const pageItems = (pages: ReadonlyArray<Page>): Array<ContextItem> =>
  pages.map((page, i) => ({
    ref: `page:${String(i + 1)}`,
    kind: 'doc_chunk',
    text: [
      `Page: ${page.url}`,
      ...(page.title === null ? [] : [`Title: ${page.title}`]),
      ...(page.description === null
        ? []
        : [`Meta description: ${page.description}`]),
      `Text:\n${page.text}`,
      `Links:\n${page.links.map((l) => (l.text === '' ? l.href : `${l.href} (${l.text})`)).join('\n')}`,
      `Images:\n${page.images.join('\n')}`,
    ].join('\n\n'),
    entityIds: [],
    at: null,
  }))

/** What the Extract lane is asked to do with the pages. */
export const WEBSITE_TASK =
  "These are pages of one company's own website. Fill the output schema from what they state. Leave a field as an empty string when the pages do not state it. Copy a profile link or the logo exactly from a page's Links or Images list; never write one that is not there."

const field = (description: string): JsonSchema => ({
  type: 'string',
  description,
})

/** The Extract lane's fixed schema: every field a string, empty when not stated. */
export const WEBSITE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...FIELD_NAMES, 'logo'],
  properties: {
    description: field(
      'What the company does, in one or two plain sentences taken from the pages.',
    ),
    location: field(
      'Where the company is based (city, region or country) when a page says so.',
    ),
    linkedin: field("The company's LinkedIn page, from the Links list."),
    twitter: field("The company's Twitter or X profile, from the Links list."),
    crunchbase: field("The company's Crunchbase profile, from the Links list."),
    blog: field("The company's blog, from the Links list."),
    logo: field("The company's logo image, from the Images list."),
  },
}

const text = z.string().catch('')

/** The Extract lane's answer, read leniently: a missing field is empty. */
export const websiteOutput = z.object({
  description: text,
  location: text,
  linkedin: text,
  twitter: text,
  crunchbase: text,
  blog: text,
  logo: text,
})

export type WebsiteOutput = z.infer<typeof websiteOutput>

/** The comparable form of a URL: no trailing slash, host lower-cased. */
const comparable = (url: string) => {
  try {
    const u = new URL(url)
    u.hash = ''
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch {
    return null
  }
}

const hostIs = (url: string, hosts: ReadonlyArray<string>) => {
  const host = siteOf(url)
  return (
    host !== null && hosts.some((h) => host === h || host.endsWith(`.${h}`))
  )
}

/** Which hosts a profile field must point at; null for any. */
const PROFILE_HOSTS: { readonly [F in FieldName]?: ReadonlyArray<string> } = {
  linkedin: ['linkedin.com'],
  twitter: ['twitter.com', 'x.com'],
  crunchbase: ['crunchbase.com'],
}

/**
 * The answers the output gives, for the keys asked:
 * - a link counts only when a page links it, on the profile's own host;
 * - the logo only when it is one of the page's logo candidates;
 * - every vocabulary answer passes the vocabulary's own check.
 */
export const websiteAnswers = (
  output: WebsiteOutput,
  pages: ReadonlyArray<Page>,
  keys: ReadonlyArray<string>,
): { [key: string]: Json } => {
  const linked = new Set(
    pages.flatMap((p) =>
      p.links.flatMap((l) => {
        const c = comparable(l.href)
        return c === null ? [] : [c]
      }),
    ),
  )
  const homes = new Set(
    pages.flatMap((p) => {
      const c = comparable(new URL('/', p.url).toString())
      return c === null ? [] : [c]
    }),
  )
  const onPage = (url: string) => {
    const c = comparable(url)
    return c !== null && linked.has(c) && !homes.has(c)
  }
  const answers: { [key: string]: Json } = {}
  for (const name of FIELD_NAMES) {
    const key = FIELDS[name]
    if (!keys.includes(key)) continue
    const said = squash(output[name])
    if (said === '') continue
    if (name === 'description' || name === 'location') {
      const value = said.slice(0, name === 'description' ? 1000 : 200)
      if (vocabularyProblem(key, value) === null) answers[key] = value
      continue
    }
    const hosts = PROFILE_HOSTS[name]
    if (!onPage(said)) continue
    if (hosts !== undefined && !hostIs(said, hosts)) continue
    if (vocabularyProblem(key, said) === null) answers[key] = said
  }
  const logo = squash(output.logo)
  const candidates = new Set(pages.flatMap((p) => p.images))
  if (
    keys.includes(LOGO_KEY) &&
    candidates.has(logo) &&
    vocabularyProblem(LOGO_KEY, logo) === null
  )
    answers[LOGO_KEY] = logo
  return answers
}

/** Where each profile key's link must point: its hosts and its path shape. */
const PROFILES: ReadonlyArray<{
  readonly key: VocabularyKey
  readonly hosts: ReadonlyArray<string>
  readonly path: RegExp
}> = [
  {
    key: 'company.linkedin',
    hosts: ['linkedin.com'],
    path: /^\/company\/[^/]+\/?$/i,
  },
  {
    key: 'company.twitter',
    hosts: ['twitter.com', 'x.com'],
    path: /^\/(?!(?:share|intent|home|i|search|hashtag)(?:\/|$))\w{1,15}\/?$/i,
  },
  {
    key: 'company.facebook',
    hosts: ['facebook.com', 'fb.com'],
    path: /^\/(?!(?:sharer|share|dialog|plugins)(?:\.php)?(?:\/|$))[^/]+\/?$/i,
  },
  {
    key: 'company.angellist',
    hosts: ['angel.co', 'wellfound.com'],
    path: /^\/company\/[^/]+\/?$/i,
  },
  {
    key: 'company.crunchbase',
    hosts: ['crunchbase.com'],
    path: /^\/organization\/[^/]+\/?$/i,
  },
]

/** The page's blog: `blog.<site>`, or `/blog` on the site itself. */
const blogOf = (page: Page): string | null => {
  const site = siteOf(page.url)
  if (site === null) return null
  for (const link of page.links) {
    const host = siteOf(link.href)
    if (host === null || (host !== site && !host.endsWith(`.${site}`))) continue
    const path = new URL(link.href).pathname
    if (host === `blog.${site}` && path === '/') return link.href
    if (/^\/blog\/?$/i.test(path)) return link.href
  }
  return null
}

/** A title that says more than the name: its longest part of three words or more. */
const titleLine = (title: string | null): string | null => {
  if (title === null) return null
  const parts = title
    .split(/\s+[|–—·:-]\s+/)
    .map(squash)
    .filter((part) => part.split(' ').length >= 3)
    .sort((a, b) => b.length - a.length)
  return parts.at(0) ?? null
}

/**
 * The markup half's answers, for the keys asked, with no model:
 * - the description is the meta description, else a telling title;
 * - each profile link is the first the page links on the profile's host;
 * - the logo is a declared icon, a touch icon first, else the share image;
 * - every answer passes the vocabulary's own check.
 */
export const markupAnswers = (
  page: Page,
  keys: ReadonlyArray<string>,
): { [key: string]: Json } => {
  const answers: { [key: string]: Json } = {}
  const offer = (key: VocabularyKey, value: string | null) => {
    if (value === null || !keys.includes(key) || key in answers) return
    if (vocabularyProblem(key, value) === null) answers[key] = value
  }
  const description = page.description ?? titleLine(page.title)
  offer(FIELDS.description, description?.slice(0, 1000) ?? null)
  for (const link of page.links) {
    const path = new URL(link.href).pathname
    for (const profile of PROFILES)
      if (hostIs(link.href, profile.hosts) && profile.path.test(path))
        offer(profile.key, link.href)
  }
  offer(FIELDS.blog, blogOf(page))
  offer(LOGO_KEY, page.icons.at(0) ?? page.shareImage)
  return answers
}
