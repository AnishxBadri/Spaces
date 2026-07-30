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

/**
 * Filenames arrive from uploads and mail attachments, so they are hostile
 * input by default: strip anything that could break out of the quoted
 * header value or forge a second header line.
 */
function safeFilename(raw: string | null): string {
  const cleaned = [...(raw ?? '')]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      // Control characters would forge header lines; quotes, backslashes and
      // slashes would escape the quoted filename or the directory.
      return code >= 0x20 && code !== 0x7f && !'"\\/'.includes(ch)
    })
    .join('')
    .trim()
    .slice(0, 200)
  return cleaned || 'download'
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

        const name = safeFilename(
          new URL(request.url).searchParams.get('name'),
        )

        return new Response(
          Readable.toWeb(createReadStream(path)) as ReadableStream,
          {
            headers: {
              // Never echo the upload's own content-type: an uploaded .html
              // served as text/html from this origin is stored XSS against
              // the app. Everything downloads as an opaque attachment until
              // there's a preview surface that has thought about this.
              'content-type': 'application/octet-stream',
              'content-disposition': `attachment; filename="${name}"`,
              'x-content-type-options': 'nosniff',
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

        try {
          await new LocalStorage().putContentAddressed(
            params.key,
            Readable.fromWeb(request.body as never),
          )
        } catch (err) {
          return new Response(
            err instanceof Error ? err.message : 'Upload failed',
            { status: 400 },
          )
        }
        return new Response(null, { status: 201 })
      },
    },
  },
})
