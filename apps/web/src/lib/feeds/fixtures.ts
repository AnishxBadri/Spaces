import { vi } from 'vitest'

/**
 * A stand-in for the web, behind `fetch`: each URL answers what its route
 * says, and every request's headers are kept. Nothing here opens a socket.
 */

export type Route = (headers: Headers) => {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: string | Uint8Array
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
      const body =
        answer.body === undefined
          ? null
          : typeof answer.body === 'string'
            ? answer.body
            : new Blob([Uint8Array.from(answer.body)])
      return Promise.resolve(
        new Response(body, {
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

const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  ico: [0x00, 0x00, 0x01, 0x00, 0x01, 0x00],
} as const

/**
 * A picture by its bytes: the type's magic number, then random filler, so
 * no two calls share a digest. The local store outlives the database.
 */
export const pictureOf = (type: keyof typeof MAGIC, size = 64): Uint8Array => {
  const out = new Uint8Array(Math.max(size, 80))
  out.set(crypto.getRandomValues(new Uint8Array(64)), 16)
  out.set(MAGIC[type])
  return out
}
