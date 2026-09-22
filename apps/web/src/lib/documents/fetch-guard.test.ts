import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_REDIRECTS, guardedFetch, urlRefusal } from './fetch-guard'

/**
 * The SSRF table (SPA-117), and the acceptance criterion that it is checked
 * **without touching the network**. Every case below is either a pure call to
 * `urlRefusal` or a `guardedFetch` driven against a stubbed `fetch` — nothing
 * here opens a socket, which is the point: a guard whose tests need the
 * internet is a guard nobody runs.
 *
 * The redirect case is the one that cannot be pure and is also the one that
 * matters most. A public URL answering `302 → http://10.0.0.5/` is the whole
 * attack the manual-redirect loop exists for, and a guard that only checked
 * the URL the reader typed would walk straight into it.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('urlRefusal — the table', () => {
  it('passes an ordinary public https URL', () => {
    expect(urlRefusal('https://example.com/an-article')).toBeNull()
    expect(urlRefusal('http://example.com:8080/x?y=1#z')).toBeNull()
  })

  it.each([
    ['http://localhost:3000/admin', 'local network name'],
    ['http://LOCALHOST/', 'local network name'],
    ['http://localhost./', 'local network name'],
    ['http://wiki.internal/page', 'local network name'],
    ['http://printer.local/', 'local network name'],
    ['http://127.0.0.1:5432/', 'loopback'],
    ['http://127.1.2.3/', 'loopback'],
    ['http://10.0.0.5/secrets', 'private'],
    ['http://172.16.4.2/', 'private'],
    ['http://172.31.255.255/', 'private'],
    ['http://192.168.1.1/', 'private'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local'],
    ['http://0.0.0.0/', 'unspecified'],
    ['http://[::1]/', 'loopback'],
    ['http://[fc00::1]/', 'unique-local'],
    ['http://[fd12:3456::1]/', 'unique-local'],
    ['http://[fe80::1]/', 'link-local'],
    ['http://[::ffff:127.0.0.1]/', 'loopback'],
  ])('refuses %s', (url, because) => {
    const refusal = urlRefusal(url)
    expect(refusal).not.toBeNull()
    expect(refusal).toContain(because)
  })

  it('refuses every scheme that is not http or https', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://files.example.com/x',
      'gopher://example.com/',
      'data:text/html,<h1>hi</h1>',
      'javascript:alert(1)',
    ]) {
      expect(urlRefusal(url)).toContain('only fetches http and https')
    }
  })

  it('refuses something that is not a URL at all', () => {
    expect(urlRefusal('not a url')).toContain('is not a URL')
    expect(urlRefusal('')).toContain('is not a URL')
  })

  // 172.15 and 172.32 are public; the /12 is 172.16–172.31 and a guard that
  // refused the whole /8 would quietly refuse real sites.
  it('does not over-refuse the edges of the private ranges', () => {
    expect(urlRefusal('http://172.15.0.1/')).toBeNull()
    expect(urlRefusal('http://172.32.0.1/')).toBeNull()
    expect(urlRefusal('http://11.0.0.1/')).toBeNull()
    expect(urlRefusal('http://169.253.0.1/')).toBeNull()
  })
})

/** A `Response` the stub can hand back, with no body when there is no need. */
function response(
  init: { status: number; headers?: Record<string, string> },
  body?: string,
): Response {
  return new Response(body ?? null, {
    status: init.status,
    ...(init.headers === undefined ? {} : { headers: init.headers }),
  })
}

describe('guardedFetch', () => {
  it('refuses a redirect whose Location is a private address', async () => {
    const calls: Array<string> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url)
        return Promise.resolve(
          response({
            status: 302,
            headers: { location: 'http://10.1.2.3/internal' },
          }),
        )
      }),
    )

    const out = await guardedFetch('https://example.com/post', {
      maxBytes: 1024,
      timeoutMs: 1000,
    })

    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.kind).toBe('refused')
    expect(out.reason).toContain('10.1.2.3')
    expect(out.reason).toContain('private')
    // The public first hop was fetched; the private second one never was.
    expect(calls).toEqual(['https://example.com/post'])
  })

  it('follows a public redirect, including a relative Location', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url === 'https://example.com/post'
            ? response({ status: 301, headers: { location: '/final' } })
            : response(
                { status: 200, headers: { 'content-type': 'text/html' } },
                '<p>hello</p>',
              ),
        ),
      ),
    )

    const out = await guardedFetch('https://example.com/post', {
      maxBytes: 1024,
      timeoutMs: 1000,
    })

    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('unreachable')
    expect(out.url).toBe('https://example.com/final')
    expect(out.contentType).toBe('text/html')
    expect(new TextDecoder().decode(out.bytes)).toBe('<p>hello</p>')
  })

  it('gives up after the redirect cap rather than looping', async () => {
    let hop = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        hop += 1
        return Promise.resolve(
          response({
            status: 302,
            headers: { location: `https://example.com/${String(hop)}` },
          }),
        )
      }),
    )

    const out = await guardedFetch('https://example.com/0', {
      maxBytes: 1024,
      timeoutMs: 1000,
    })

    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toContain('redirects')
    expect(hop).toBe(MAX_REDIRECTS + 1)
  })

  it('refuses a body past the byte cap instead of buffering it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(
            { status: 200, headers: { 'content-type': 'text/html' } },
            'x'.repeat(5000),
          ),
        ),
      ),
    )

    const out = await guardedFetch('https://example.com/huge', {
      maxBytes: 100,
      timeoutMs: 1000,
    })

    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.kind).toBe('refused')
    expect(out.reason).toContain('100 byte limit')
  })

  it('reports a non-2xx as a network failure, not a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response({ status: 404 }))),
    )

    const out = await guardedFetch('https://example.com/gone', {
      maxBytes: 1024,
      timeoutMs: 1000,
    })

    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.kind).toBe('network')
    expect(out.reason).toContain('404')
  })

  it('refuses a private URL before it calls fetch at all', async () => {
    const spy = vi.fn(() => Promise.resolve(response({ status: 200 })))
    vi.stubGlobal('fetch', spy)

    const out = await guardedFetch('http://169.254.169.254/latest/meta-data/', {
      maxBytes: 1024,
      timeoutMs: 1000,
    })

    expect(out.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
