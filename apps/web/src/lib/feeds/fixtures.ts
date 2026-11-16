import { vi } from 'vitest'

/**
 * A stand-in for the web, behind `fetch`: each URL answers what its route
 * says, and every request's headers are kept. Nothing here opens a socket.
 */

export type Route = (headers: Headers) => {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: string
}

export const stubSite = (routes: Record<string, Route>) => {
  const requests: Array<{ url: string; headers: Headers }> = []
  const table = new Map(Object.entries(routes))
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      requests.push({ url, headers })
      const route = table.get(url)
      if (route === undefined)
        return Promise.resolve(new Response(null, { status: 404 }))
      const answer = route(headers)
      return Promise.resolve(
        new Response(answer.body ?? null, {
          status: answer.status,
          ...(answer.headers === undefined ? {} : { headers: answer.headers }),
        }),
      )
    }),
  )
  return requests
}

/** An RSS 2.0 document with one `<item>` per entry. */
export const rssOf = (
  items: ReadonlyArray<{
    readonly guid: string
    readonly title: string
    readonly date: string
  }>,
  title = 'SpaceNews',
) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://spacenews.com/</link>${items
    .map(
      (i) =>
        `<item><guid>${i.guid}</guid><title>${i.title}</title><link>https://spacenews.com/${i.guid}/</link><pubDate>${new Date(i.date).toUTCString()}</pubDate><description><![CDATA[<p>${i.title}, the story.</p><p>Second paragraph.</p>]]></description><media:thumbnail url="https://spacenews.com/img/${i.guid}.jpg"/></item>`,
    )
    .join('')}</channel></rss>`
