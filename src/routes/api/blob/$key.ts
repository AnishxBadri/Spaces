import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createFileRoute } from '@tanstack/react-router'
import { LocalStorage, blobPath, verifyBlobToken } from '#/lib/storage/local'

/**
 * The local driver's "presigned URL" endpoint. The HMAC token is the
 * authorization — same semantics as an S3 presigned URL: whoever holds the
 * link can use it until it expires.
 */

function checkToken(request: Request, key: string, verb: 'get' | 'put') {
  const url = new URL(request.url)
  const exp = Number(url.searchParams.get('exp'))
  const sig = url.searchParams.get('sig') ?? ''
  if (!exp || !sig || !verifyBlobToken(key, verb, exp, sig)) {
    return new Response('Invalid or expired blob token', { status: 403 })
  }
  return null
}

export const Route = createFileRoute('/api/blob/$key')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const denied = checkToken(request, params.key, 'get')
        if (denied) return denied

        const path = blobPath(params.key)
        const info = await stat(path).catch(() => null)
        if (!info) return new Response('Not found', { status: 404 })

        return new Response(
          Readable.toWeb(createReadStream(path)) as ReadableStream,
          {
            headers: {
              'content-length': String(info.size),
              // Content-addressed keys are immutable — cache forever.
              'cache-control': 'private, max-age=31536000, immutable',
            },
          },
        )
      },

      PUT: async ({ request, params }) => {
        const denied = checkToken(request, params.key, 'put')
        if (denied) return denied
        if (!request.body) return new Response('Empty body', { status: 400 })

        await new LocalStorage().put(
          params.key,
          Readable.fromWeb(request.body as never),
          {},
        )
        return new Response(null, { status: 201 })
      },
    },
  },
})
