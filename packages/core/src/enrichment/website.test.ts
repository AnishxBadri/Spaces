import { describe, expect, it } from 'vitest'
import { enrichedLine } from './plan'
import { enrichmentSettingsOf, withBuiltIn } from './settings'
import {
  LOGO_KEY,
  WEBSITE_KEYS,
  aboutLinkOf,
  isHtml,
  markupAnswers,
  pageItems,
  readPage,
  websiteAnswers,
  websiteLabel,
} from './website'
import type { WebsiteOutput } from './website'

/** The Website source's pure half: a page read, the about link, both halves' answers. (D76, D80) */

const HOME = `<!doctype html>
<html><head>
  <title>Keyhold &amp; Co</title>
  <meta name="description" content="Keys for property managers.">
  <meta property="og:image" content="/share.png">
  <link rel="apple-touch-icon" href="/touch.png">
  <style>.x { color: red }</style>
  <script>window.track = 'never read'</script>
</head><body>
  <header><img src="/img/keyhold-logo.svg" alt="Keyhold"></header>
  <h1>Keyhold</h1>
  <p>Keyhold runs key handover for rental homes.</p>
  <noscript>Enable JavaScript</noscript>
  <a href="/about-us">About us</a>
  <a href="https://www.linkedin.com/company/keyhold/">LinkedIn</a>
  <a href="https://x.com/keyhold" aria-label="X"></a>
  <a href="https://blog.keyhold.example/">Blog</a>
  <a href="mailto:hi@keyhold.example">Mail</a>
</body></html>`

const output = (over: Partial<WebsiteOutput>): WebsiteOutput => ({
  description: '',
  location: '',
  linkedin: '',
  twitter: '',
  crunchbase: '',
  blog: '',
  logo: '',
  ...over,
})

describe('readPage', () => {
  const page = readPage(HOME, 'https://keyhold.example/')

  it('reads the title, the description and the text, never a script', () => {
    expect(page.title).toBe('Keyhold & Co')
    expect(page.description).toBe('Keys for property managers.')
    expect(page.text).toContain('Keyhold runs key handover for rental homes.')
    expect(page.text).not.toContain('never read')
    expect(page.text).not.toContain('color: red')
    expect(page.text).not.toContain('Enable JavaScript')
  })

  it('keeps http(s) links absolute, with their words or label', () => {
    expect(page.links).toEqual([
      { href: 'https://keyhold.example/about-us', text: 'About us' },
      {
        href: 'https://www.linkedin.com/company/keyhold/',
        text: 'LinkedIn',
      },
      { href: 'https://x.com/keyhold', text: 'X' },
      { href: 'https://blog.keyhold.example/', text: 'Blog' },
    ])
  })

  it('collects logo candidates: a logo image, the icons, the share image', () => {
    expect(page.images).toEqual([
      'https://keyhold.example/img/keyhold-logo.svg',
      'https://keyhold.example/touch.png',
      'https://keyhold.example/share.png',
    ])
  })

  it('keeps the declared icons, a touch icon first, and the share image apart', () => {
    expect(page.icons).toEqual(['https://keyhold.example/touch.png'])
    expect(page.shareImage).toBe('https://keyhold.example/share.png')
  })

  it('finds the about page on its own site', () => {
    expect(aboutLinkOf(page)).toBe('https://keyhold.example/about-us')
    const elsewhere = readPage(
      '<a href="https://other.example/about">About</a>',
      'https://keyhold.example/',
    )
    expect(aboutLinkOf(elsewhere)).toBeNull()
  })

  it('hands the model the page, its links and its images', () => {
    const [item] = pageItems([page])
    expect(item.ref).toBe('page:1')
    expect(item.text).toContain('https://x.com/keyhold (X)')
    expect(item.text).toContain('Images:\nhttps://keyhold.example/img/')
  })

  it('takes HTML by its type, else by its first bytes', () => {
    expect(isHtml('text/html; charset=utf-8', '')).toBe(true)
    expect(isHtml('application/json', '<html>')).toBe(false)
    expect(isHtml(null, '  <!DOCTYPE html><html>')).toBe(true)
  })
})

describe('websiteAnswers', () => {
  const page = readPage(HOME, 'https://keyhold.example/')

  it('answers the keys asked, the logo among them', () => {
    expect(
      websiteAnswers(
        output({
          description: '  Keyhold runs key handover.  ',
          location: 'Bengaluru, India',
          linkedin: 'https://www.linkedin.com/company/keyhold',
          twitter: 'https://x.com/keyhold',
          blog: 'https://blog.keyhold.example/',
          logo: 'https://keyhold.example/img/keyhold-logo.svg',
        }),
        [page],
        WEBSITE_KEYS,
      ),
    ).toEqual({
      'company.description': 'Keyhold runs key handover.',
      'company.location': 'Bengaluru, India',
      'company.linkedin': 'https://www.linkedin.com/company/keyhold',
      'company.twitter': 'https://x.com/keyhold',
      'company.blog': 'https://blog.keyhold.example/',
      [LOGO_KEY]: 'https://keyhold.example/img/keyhold-logo.svg',
    })
  })

  it('leaves out a key nobody asked for', () => {
    expect(
      websiteAnswers(
        output({ description: 'Keys.', location: 'Pune' }),
        [page],
        ['company.location'],
      ),
    ).toEqual({ 'company.location': 'Pune' })
    expect(
      websiteAnswers(
        output({ logo: 'https://keyhold.example/img/keyhold-logo.svg' }),
        [page],
        ['company.location'],
      ),
    ).toEqual({})
  })

  it('never answers a link the page does not carry, or one on the wrong host', () => {
    expect(
      websiteAnswers(
        output({
          linkedin: 'https://www.linkedin.com/company/invented',
          twitter: 'https://blog.keyhold.example/',
          crunchbase: 'https://www.crunchbase.com/organization/keyhold',
          blog: 'https://keyhold.example/',
          logo: 'https://keyhold.example/elsewhere.png',
        }),
        [page],
        WEBSITE_KEYS,
      ),
    ).toEqual({})
  })
})

describe('markupAnswers', () => {
  const page = readPage(HOME, 'https://keyhold.example/')

  it('answers from the markup alone: the meta description, the profile links, the blog, the icon', () => {
    expect(markupAnswers(page, WEBSITE_KEYS)).toEqual({
      'company.description': 'Keys for property managers.',
      'company.linkedin': 'https://www.linkedin.com/company/keyhold/',
      'company.twitter': 'https://x.com/keyhold',
      'company.blog': 'https://blog.keyhold.example/',
      [LOGO_KEY]: 'https://keyhold.example/touch.png',
    })
  })

  it('takes a telling title when there is no description, and the share image when there is no icon', () => {
    const bare = readPage(
      `<title>Keyhold | Key handover for rental homes</title>
       <meta property="og:image" content="https://cdn.example/k.png">
       <link rel="icon" href="/favicon.svg">
       <a href="https://facebook.com/sharer.php?u=x">Share</a>
       <a href="https://www.facebook.com/keyhold">Facebook</a>
       <a href="https://wellfound.com/company/keyhold">Wellfound</a>
       <a href="https://www.crunchbase.com/organization/keyhold">CB</a>
       <a href="/blog/">Blog</a>`,
      'https://keyhold.example/',
    )
    expect(markupAnswers(bare, WEBSITE_KEYS)).toEqual({
      'company.description': 'Key handover for rental homes',
      'company.facebook': 'https://www.facebook.com/keyhold',
      'company.angellist': 'https://wellfound.com/company/keyhold',
      'company.crunchbase': 'https://www.crunchbase.com/organization/keyhold',
      'company.blog': 'https://keyhold.example/blog/',
      [LOGO_KEY]: 'https://cdn.example/k.png',
    })
  })

  it('answers nothing a page does not say, and no key nobody asked for', () => {
    const plain = readPage(
      `<title>Keyhold</title>
       <a href="https://twitter.com/intent/tweet">Tweet</a>
       <a href="https://www.linkedin.com/shareArticle?url=x">Share</a>`,
      'https://keyhold.example/',
    )
    expect(markupAnswers(plain, WEBSITE_KEYS)).toEqual({})
    expect(markupAnswers(page, ['company.location'])).toEqual({})
  })

  it('names the halves that ran on the timeline', () => {
    expect(websiteLabel(false)).toBe('Website (markup)')
    expect(websiteLabel(true)).toBe('Website (markup + model)')
  })
})

describe('the order and the line', () => {
  const settings = (sources: Array<string> | null) =>
    enrichmentSettingsOf(sources === null ? {} : { enrichment: { sources } })
  const web = { id: '00000000-0000-4000-8000-000000000001' }
  const apollo = { id: '00000000-0000-4000-8000-000000000002' }

  it('puts the Website first, unless the owner placed it', () => {
    expect(withBuiltIn(settings(null), web, [apollo])).toEqual([web, apollo])
    expect(withBuiltIn(settings([apollo.id]), web, [apollo])).toEqual([
      web,
      apollo,
    ])
    expect(withBuiltIn(settings([apollo.id, web.id]), web, [apollo])).toEqual([
      apollo,
      web,
    ])
    expect(withBuiltIn(settings(null), null, [apollo])).toEqual([apollo])
  })

  it('says a skip the owner should see, alone when nothing ran', () => {
    const skipped = [{ name: 'Website', why: 'sensitive' }]
    expect(
      enrichedLine({ sources: ['Apollo'], fields: 2, credits: 1, skipped }),
    ).toBe(
      'Enriched · Apollo · 2 fields · 1 credit · Website skipped · sensitive',
    )
    expect(enrichedLine({ sources: [], fields: 0, credits: 0, skipped })).toBe(
      'Website skipped · sensitive',
    )
  })
})
