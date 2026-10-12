import { simpleParser } from 'mailparser'
import { describe, expect, it } from 'vitest'
import { CHART_PNG, TRACKER, htmlEmail } from './fixtures'
import { sanitizeEmailHtml, stripRemoteCss } from './sanitize'

/** The viewer's body, asserted on the sanitized output. (D67) */

const rendered = async () => {
  const parsed = await simpleParser(
    htmlEmail({ messageId: 'q3@acme.example', to: 'anish@fund.example' }),
  )
  if (typeof parsed.html !== 'string') throw new Error('no html part')
  return sanitizeEmailHtml(parsed.html)
}

describe('sanitizeEmailHtml', () => {
  it('renders neither the script nor the tracking pixel', async () => {
    const { srcdoc } = await rendered()
    expect(srcdoc).not.toMatch(/<script/i)
    expect(srcdoc).not.toContain('document.cookie')
    expect(srcdoc).not.toContain(TRACKER)
    expect(srcdoc).not.toContain('track.example')
    expect(srcdoc).not.toMatch(/onclick/i)
  })

  it('drops forms and refuses every load but data: inside the document', async () => {
    const { srcdoc } = await rendered()
    expect(srcdoc).not.toMatch(/<form|<input/i)
    expect(srcdoc).toContain(
      `content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"`,
    )
  })

  it('renders the cid: image inline and counts the remote ones, each at its size', async () => {
    const { srcdoc, remoteImages } = await rendered()
    expect(srcdoc).toContain(`data:image/png;base64,${CHART_PNG}`)
    expect(remoteImages).toBe(2)
    expect(srcdoc).not.toContain('cdn.acme.example')
    const placeholders = srcdoc.match(/<img[^>]*data-remote-image[^>]*>/g) ?? []
    expect(placeholders).toHaveLength(2)
    expect(placeholders.some((p) => /width="120"/.test(p))).toBe(true)
    expect(placeholders.some((p) => /height="32"/.test(p))).toBe(true)
  })

  it('opens web links in a new tab with noopener, and leaves a mailto: as text', async () => {
    const { srcdoc } = await rendered()
    expect(srcdoc).toMatch(
      /<a href="https:\/\/acme\.example\/deck" target="_blank" rel="noopener noreferrer">the deck<\/a>/,
    )
    expect(srcdoc).not.toContain('mailto:')
    expect(srcdoc).toContain('Jane')
  })

  it('shows an unresolved cid: as a placeholder without counting it as remote', () => {
    const { srcdoc, remoteImages } = sanitizeEmailHtml(
      '<p><img src="cid:gone@acme" width="40" height="20"></p>',
    )
    expect(remoteImages).toBe(0)
    expect(srcdoc).not.toContain('cid:gone')
    expect(srcdoc).toMatch(/<img[^>]*data-missing-part[^>]*>/)
    expect(srcdoc).not.toContain('data-remote-image')
  })

  it('strips remote url() and @import from CSS, keeping data:', () => {
    expect(
      stripRemoteCss(
        '@import "https://x.example/a.css"; a{background:url(https://x.example/b.png)} b{background:url("data:image/png;base64,AA")}',
      ),
    ).toBe(' a{background:none} b{background:url("data:image/png;base64,AA")}')
  })
})
