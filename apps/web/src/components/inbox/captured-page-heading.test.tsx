import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CapturedPageHeading } from './captured-page-heading'

/**
 * SPA-134: a captured page's card in /inbox has no record to chip, so it is
 * headed by the page — its title, "from a captured page", and the address
 * it was captured from. Server-rendered like `inbox.test.tsx`, no DOM.
 */
describe('the captured page heading', () => {
  it('names the page and links the address it was captured from', () => {
    const html = renderToStaticMarkup(
      <CapturedPageHeading
        page={{
          title: 'Katya Milev',
          url: 'https://www.linkedin.com/in/katya-milev/',
        }}
      />,
    )
    expect(html).toContain('Katya Milev')
    expect(html).toContain('from a captured page')
    expect(html).toContain('href="https://www.linkedin.com/in/katya-milev/"')
  })

  it('draws no link for a page with no address', () => {
    const html = renderToStaticMarkup(
      <CapturedPageHeading page={{ title: 'Pasted page', url: null }} />,
    )
    expect(html).toContain('Pasted page')
    expect(html).not.toContain('href=')
  })
})
