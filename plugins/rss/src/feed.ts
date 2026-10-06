import { DateTime, Option } from 'effect'

/**
 * RSS 2.0 and Atom, read with string matching rather than an XML parser.
 * - Enough for the two formats' item fields: exact element names (so RSS's
 *   `<atom:link>` is never read as `<link>`), CDATA, the XML entities.
 * - An item's key is its `guid` (RSS) or `id` (Atom), else its link; an
 *   item with neither is dropped — it cannot be deduped.
 * - Pure: no ports, no clock.
 */

export type FeedItem = {
  readonly key: string
  readonly title: string | null
  readonly url: string | null
  /** ISO-8601, or null when the feed gave no date that parses. */
  readonly publishedAt: string | null
  /** Plain text, tags stripped, at most `SUMMARY_MAX` characters. */
  readonly summary: string | null
}

export type Feed = {
  readonly format: 'rss' | 'atom'
  readonly title: string | null
  /** In document order — newest first, by convention. */
  readonly items: ReadonlyArray<FeedItem>
}

export const SUMMARY_MAX = 500

const ENTITIES: { readonly [name: string]: string } = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(ref.slice(2), 16))
    if (ref.startsWith('#'))
      return String.fromCodePoint(Number.parseInt(ref.slice(1), 10))
    return ENTITIES[ref.toLowerCase()] ?? whole
  })

/** A block tag becomes a space, an inline one nothing: `<b>x</b>.` stays `x.`. */
const stripTags = (text: string): string =>
  text
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|blockquote)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g

/** An element's text: CDATA kept as is, child tags dropped, entities decoded. */
const textOf = (inner: string): string => {
  let out = ''
  let last = 0
  for (const match of inner.matchAll(CDATA)) {
    out += decode(stripTags(inner.slice(last, match.index)))
    out += match.at(1) ?? ''
    last = match.index + match[0].length
  }
  return out + decode(stripTags(inner.slice(last)))
}

/** Escaped HTML in a title or summary, reduced to its words. */
const plain = (inner: string): string =>
  squash(decode(stripTags(textOf(inner))))

type Element = { readonly attrs: string; readonly inner: string }

/** Every `<name …>…</name>` and `<name …/>` in `xml`, in order. */
const elements = (xml: string, name: string): ReadonlyArray<Element> => {
  const pattern = new RegExp(
    `<${name}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${name}\\s*>)`,
    'g',
  )
  return [...xml.matchAll(pattern)].map((m) => ({
    attrs: m.at(1) ?? '',
    inner: m.at(2) ?? '',
  }))
}

const first = (xml: string, ...names: ReadonlyArray<string>): string | null => {
  for (const name of names) {
    const found = elements(xml, name).at(0)
    if (found === undefined) continue
    const text = plain(found.inner)
    if (text !== '') return text
  }
  return null
}

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  const value = m?.at(1) ?? m?.at(2)
  return value === undefined ? null : decode(value)
}

const isoOf = (raw: string | null): string | null =>
  raw === null
    ? null
    : Option.getOrNull(Option.map(DateTime.make(raw), DateTime.formatIso))

const summaryOf = (text: string | null): string | null =>
  text === null
    ? null
    : text.length <= SUMMARY_MAX
      ? text
      : `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…`

const item = (fields: Omit<FeedItem, 'key'>, key: string | null) =>
  key === null ? [] : [{ key, ...fields }]

const rssItem = (xml: string): ReadonlyArray<FeedItem> => {
  const url = first(xml, 'link')
  return item(
    {
      title: first(xml, 'title'),
      url,
      publishedAt: isoOf(first(xml, 'pubDate', 'dc:date')),
      summary: summaryOf(first(xml, 'description', 'content:encoded')),
    },
    first(xml, 'guid') ?? url,
  )
}

/** The `alternate` link, or the first link with no `rel`. */
const atomLink = (xml: string): string | null => {
  for (const link of elements(xml, 'link')) {
    const rel = attr(link.attrs, 'rel')
    const href = attr(link.attrs, 'href')
    if (href !== null && (rel === null || rel === 'alternate')) return href
  }
  return null
}

const atomEntry = (xml: string): ReadonlyArray<FeedItem> => {
  const url = atomLink(xml)
  return item(
    {
      title: first(xml, 'title'),
      url,
      publishedAt: isoOf(first(xml, 'published', 'updated')),
      summary: summaryOf(first(xml, 'summary', 'content')),
    },
    first(xml, 'id') ?? url,
  )
}

/** The part of the document before its first item: where the feed's own title is. */
const head = (xml: string, tag: string): string => {
  const at = xml.search(new RegExp(`<${tag}[\\s>]`))
  return at < 0 ? xml : xml.slice(0, at)
}

/** The feed, or null when `xml` is neither RSS nor Atom. */
export const parseFeed = (xml: string): Feed | null => {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  if (/<(rss|rdf:RDF)[\s>]/.test(body)) {
    return {
      format: 'rss',
      title: first(head(body, 'item'), 'title'),
      items: elements(body, 'item').flatMap((e) => rssItem(e.inner)),
    }
  }
  if (/<feed[\s>]/.test(body)) {
    return {
      format: 'atom',
      title: first(head(body, 'entry'), 'title'),
      items: elements(body, 'entry').flatMap((e) => atomEntry(e.inner)),
    }
  }
  return null
}
