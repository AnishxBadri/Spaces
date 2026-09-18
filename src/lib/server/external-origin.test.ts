import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_URL,
  describeExternalOrigin,
  externalOriginLogLine,
  logExternalOrigin,
} from './external-origin'

describe('describeExternalOrigin', () => {
  it('reports the three facts for an https origin', () => {
    const d = describeExternalOrigin('https://deals.example.com')
    expect(d).toEqual({
      origin: 'https://deals.example.com',
      cookieSecure: true,
      presignOrigin: 'https://deals.example.com',
      warning: null,
    })
  })

  it('falls back to the localhost default when APP_URL is unset', () => {
    expect(describeExternalOrigin(undefined).origin).toBe(DEFAULT_APP_URL)
    expect(describeExternalOrigin('  ').origin).toBe(DEFAULT_APP_URL)
  })

  it('strips a trailing slash, the way auth/members/storage already do', () => {
    const d = describeExternalOrigin('https://deals.example.com/')
    expect(d.origin).toBe('https://deals.example.com')
    expect(d.presignOrigin).toBe('https://deals.example.com')
  })

  it('keeps a path component, because those three callers keep it', () => {
    expect(describeExternalOrigin('https://example.com/spaces').origin).toBe(
      'https://example.com/spaces',
    )
  })

  it('cookies are Secure exactly when the scheme is https', () => {
    expect(describeExternalOrigin('https://example.com').cookieSecure).toBe(
      true,
    )
    expect(describeExternalOrigin('http://example.com').cookieSecure).toBe(
      false,
    )
  })
})

describe('the http-on-a-public-host warning', () => {
  it('fires for plain http on a real hostname', () => {
    const d = describeExternalOrigin('http://deals.example.com')
    expect(d.warning).toContain('deals.example.com')
    expect(d.warning).toContain('https://deals.example.com')
  })

  it('does not fire for localhost, 127.0.0.1 or ::1', () => {
    expect(describeExternalOrigin('http://localhost:3000').warning).toBeNull()
    expect(describeExternalOrigin('http://127.0.0.1:3000').warning).toBeNull()
    expect(describeExternalOrigin('http://[::1]:3000').warning).toBeNull()
    expect(describeExternalOrigin(undefined).warning).toBeNull()
  })

  it('does not fire for https anywhere', () => {
    expect(
      describeExternalOrigin('https://deals.example.com').warning,
    ).toBeNull()
    expect(describeExternalOrigin('https://localhost').warning).toBeNull()
  })

  it('warns instead of throwing on an unparseable APP_URL', () => {
    const d = describeExternalOrigin('deals.example.com')
    expect(d.warning).toContain('absolute URL')
    expect(d.cookieSecure).toBe(false)
  })

  it('never refuses to boot — it logs one line, then warns', () => {
    const logs: Array<string> = []
    const warns: Array<string> = []
    const d = logExternalOrigin(
      'http://deals.example.com',
      (m) => logs.push(m),
      (m) => warns.push(m),
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toBe(externalOriginLogLine(d))
    expect(logs[0]).toContain('cookies secure: no')
    expect(logs[0]).toContain('presign origin http://deals.example.com')
    expect(warns).toHaveLength(1)
  })

  it('logs the line and no warning for a correct https origin', () => {
    const logs: Array<string> = []
    const warns: Array<string> = []
    logExternalOrigin(
      'https://deals.example.com',
      (m) => logs.push(m),
      (m) => warns.push(m),
    )
    expect(logs[0]).toContain('cookies secure: yes')
    expect(warns).toEqual([])
  })
})

/**
 * Hostability contract #3 says the forwarded-proto header is trusted "only
 * from the proxy". Today it is trusted nowhere — nothing in `src` reads it —
 * and that is the stronger answer: every external URL comes from APP_URL, so
 * a spoofed header changes nothing. This test pins that. Introducing a read
 * of a forwarded header (or even naming one in a comment) fails the suite,
 * which forces the proxy-trust question to be decided on purpose rather than
 * arrived at by a one-line convenience.
 */
describe('the proxy-trust non-decision', () => {
  const srcDir = fileURLToPath(new URL('../..', import.meta.url))
  const selfPath = fileURLToPath(import.meta.url)
  const FORWARDED = /x-forwarded-(proto|host)/i

  function sourceFiles(dir: string): Array<string> {
    const out: Array<string> = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) out.push(...sourceFiles(full))
      else if (['.ts', '.tsx'].includes(extname(e.name)) && full !== selfPath)
        out.push(full)
    }
    return out
  }

  it('no source file mentions a forwarded proto/host header', () => {
    const offenders = sourceFiles(srcDir)
      .filter((f) => FORWARDED.test(readFileSync(f, 'utf8')))
      .map((f) => relative(srcDir, f))
    expect(offenders).toEqual([])
  })
})
