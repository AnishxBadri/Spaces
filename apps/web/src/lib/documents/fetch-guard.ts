/**
 * **The one URL guard** (SPA-117, `docs/spec-storage-sources.md` §3.1 entry
 * point 5).
 *
 * A self-hosted Spaces runs inside the operator's network, beside whatever
 * else is on it: a metadata endpoint, a Postgres on a private subnet, an
 * intranet wiki. "Fetch this URL for me" is therefore a request to make the
 * server issue a request, and the reason this module exists at all is that
 * the *only* safe answer is a table of what the server refuses — refusing
 * loopback, the RFC 1918 ranges, link-local (169.254/16, which is where the
 * cloud metadata endpoint lives), unique-local IPv6, and every scheme that
 * is not http or https.
 *
 * It lives in its own module, and not inside the clip, because
 * **docsurf-10b's PDF branch reuses it**: a URL whose response turns out to
 * be a PDF becomes a real blob through intake, and it must arrive through
 * this same table rather than a second one written from memory a fortnight
 * later. Two guard tables is how one of them ends up missing 169.254.
 *
 * It lives in `lib/documents/` and **not** `lib/server/`: the server-fns
 * barrel re-exports `lib/server/*` wholesale to the browser and a plain
 * export there ships with it (CLAUDE.md → Traps, SPA-155), while
 * `fetch-guard.test.ts` has to call these without a request. Same
 * arrangement as `birth.ts` and `refile.ts`.
 *
 * **What it does not do: resolve DNS.** `urlRefusal` reads the host as
 * written, so `evil.example` with an A record pointing at 127.0.0.1 passes
 * the table and is caught by nothing here. Closing that means resolving the
 * name, checking every address, and then connecting to the address rather
 * than the name — a custom dispatcher, not a predicate — and it buys little
 * against an attacker who can already run DNS: the deployment-level answer
 * is an egress policy. What this table does buy is that the obvious
 * targets, the ones a person types by hand and the ones a redirect chain
 * walks into, are refused in a sentence the operator can read.
 */

/** How many `Location` hops one fetch may walk before it is a loop. */
export const MAX_REDIRECTS = 5

/**
 * What a guarded fetch answers with. A discriminated union rather than a
 * throw: every caller is a worker job whose whole contract is to turn the
 * outcome into an `extraction_status` and a sentence, and a `reason` in the
 * value is one less `catch` that can swallow it.
 *
 * `bytes` and not text, because the second caller is docsurf-10b's PDF
 * branch, which needs the octets to hash and store. The clip decodes.
 */
export type GuardedFetchResult =
  | {
      readonly ok: true
      /** The URL the bytes actually came from — after every redirect. */
      readonly url: string
      readonly status: number
      readonly contentType: string | null
      readonly bytes: Uint8Array
    }
  | {
      readonly ok: false
      /**
       * `refused` is this module's own judgement — the table, the redirect
       * cap, the byte cap. `network` is the world's: DNS, a reset, a
       * timeout, a 500. The clip job records both as 'failed' and neither
       * is worth a retry, but the two are different sentences and a reader
       * deciding whether their firewall is the problem needs to know which.
       */
      readonly kind: 'refused' | 'network'
      readonly reason: string
    }

/** Parse, or say why it is not a URL at all. */
function parsed(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** `[::1]` arrives bracketed from `URL.hostname`; the table wants the address. */
function bareHost(hostname: string): string {
  const unwrapped =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
  // A fully-qualified `example.com.` is the same host as `example.com`, and
  // `localhost.` is the same host as `localhost` — the trailing dot must not
  // be a way past the name table below.
  return unwrapped.replace(/\.$/, '').toLowerCase()
}

/** Dotted quad → its four octets, or null when it is a name and not an address. */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1))
  if (nums.some((n) => n < 0 || n > 255)) return null
  return [nums[0], nums[1], nums[2], nums[3]]
}

/**
 * The IPv4 half of the table. Everything here is either this machine, this
 * network, or a range no public server is reachable on — and 169.254/16 is
 * the one that matters most, because 169.254.169.254 is the cloud metadata
 * endpoint and reading it is how a credential leaves a host.
 */
function ipv4Refusal(octets: [number, number, number, number]): string | null {
  const [a, b] = octets
  const address = octets.join('.')
  const deny = (what: string) =>
    `${address} is ${what} — Spaces only fetches public http(s) addresses.`

  if (a === 0) return deny('an unspecified address')
  if (a === 10) return deny('a private address (10.0.0.0/8)')
  if (a === 127) return deny('a loopback address (127.0.0.0/8)')
  if (a === 169 && b === 254)
    return deny('a link-local address (169.254.0.0/16)')
  if (a === 172 && b >= 16 && b <= 31)
    return deny('a private address (172.16.0.0/12)')
  if (a === 192 && b === 168) return deny('a private address (192.168.0.0/16)')
  // Carrier-grade NAT, IETF protocol assignments, benchmarking, multicast and
  // the reserved top of the space: none of them is a public web server, and
  // all of them are reachable from inside somebody's network.
  if (a === 100 && b >= 64 && b <= 127)
    return deny('a shared-address-space address (100.64.0.0/10)')
  if (a === 192 && b === 0)
    return deny('an IETF-reserved address (192.0.0.0/24)')
  if (a === 198 && (b === 18 || b === 19))
    return deny('a benchmarking address (198.18.0.0/15)')
  if (a >= 224) return deny('a multicast or reserved address (224.0.0.0/4)')
  return null
}

/**
 * The IPv6 half. `::ffff:127.0.0.1` is a v4 address wearing a v6 hat and is
 * sent through the v4 table rather than given its own row — a mapped
 * loopback is a loopback.
 */
function ipv6Refusal(host: string): string | null {
  if (!host.includes(':')) return null
  const deny = (what: string) =>
    `${host} is ${what} — Spaces only fetches public http(s) addresses.`

  // `URL` normalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the mapped
  // form has to be recognised in hex as well as in dotted quad — a table that
  // only matched the dotted spelling would be walked straight past by the one
  // spelling the parser actually produces.
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (dotted) {
    const octets = ipv4Octets(dotted[1])
    if (octets) return ipv4Refusal(octets)
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (hex) {
    const high = Number.parseInt(hex[1], 16)
    const low = Number.parseInt(hex[2], 16)
    const refusal = ipv4Refusal([high >> 8, high & 0xff, low >> 8, low & 0xff])
    if (refusal !== null) return refusal
  }

  if (host === '::1') return deny('the IPv6 loopback address')
  if (host === '::') return deny('the unspecified IPv6 address')
  // fc00::/7 — unique local. The first byte is fc or fd.
  if (/^f[cd][0-9a-f]{0,2}:/.test(host))
    return deny('a unique-local IPv6 address (fc00::/7)')
  // fe80::/10 — link-local. The first byte is fe and the next nibble 8–b.
  if (/^fe[89ab][0-9a-f]?:/.test(host))
    return deny('a link-local IPv6 address (fe80::/10)')
  return null
}

/**
 * Names that mean "this machine" or "this network" without ever being an
 * address. `localhost` is the obvious one; `.local` is mDNS and `.internal`
 * is what half the cloud providers hand out on their private zones.
 */
function nameRefusal(host: string): string | null {
  const deny = () =>
    `${host} is a local network name — Spaces only fetches public http(s) addresses.`
  if (host === 'localhost' || host.endsWith('.localhost')) return deny()
  if (host.endsWith('.local') || host.endsWith('.internal')) return deny()
  if (host.endsWith('.home.arpa')) return deny()
  return null
}

/**
 * **The table.** Null means this URL may be fetched; a string is the
 * sentence the operator reads on the row, so it names the address and the
 * range rather than saying "blocked".
 *
 * Pure, and exported on its own, because it is checked three times per
 * fetch — once on what the reader typed, and once on every `Location` a
 * redirect answers with. A guard that only ran on the first URL would be no
 * guard at all: `http://example.com/x` answering `302 → http://127.0.0.1:5432`
 * is the whole attack.
 */
export function urlRefusal(raw: string): string | null {
  const url = parsed(raw.trim())
  if (url === null) return `“${raw}” is not a URL.`

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return `Spaces only fetches http and https URLs — “${url.protocol.replace(/:$/, '')}” is not one.`

  const host = bareHost(url.hostname)
  if (host === '') return `“${raw}” has no host.`

  const octets = ipv4Octets(host)
  if (octets !== null) return ipv4Refusal(octets)
  if (host.includes(':')) return ipv6Refusal(host)
  return nameRefusal(host)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  )
}

/**
 * Read the body, counting as it goes, and stop the moment the cap is passed.
 * `res.arrayBuffer()` would buy the whole thing first and *then* notice, so a
 * 4GB response is a 4GB allocation on the worker before the guard gets a
 * word in — the cap has to be enforced against the stream, not the result.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array } | { reason: string }> {
  const body = res.body
  if (body === null) return { bytes: new Uint8Array() }

  const chunks: Array<Uint8Array> = []
  let total = 0
  const reader = body.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return {
        reason: `The page is larger than the ${String(maxBytes)} byte limit.`,
      }
    }
    chunks.push(next.value)
  }

  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return { bytes }
}

export type GuardedFetchOptions = {
  /** Hard cap on the body. Counted against the stream, not the result. */
  readonly maxBytes: number
  /** Total wall clock for the whole chain — every hop and the body read. */
  readonly timeoutMs: number
}

/**
 * **One guarded fetch**: the table on the URL, then `redirect: 'manual'` so
 * every `Location` goes back through the table before it is followed, a cap
 * of {@link MAX_REDIRECTS} hops, one `AbortSignal.timeout` shared by the
 * whole chain, and a byte cap counted off the stream.
 *
 * `redirect: 'manual'` is the load-bearing word. `fetch`'s default follows
 * redirects itself, inside undici, where nothing can inspect the hops — so a
 * public URL that 302s to `http://169.254.169.254/` would be fetched for us
 * by the runtime and the guard would have checked only the first address. A
 * manual redirect hands the 3xx back and this loop decides.
 *
 * The timeout is one signal created before the loop, not one per hop: five
 * hops each given the full budget is five times the budget, and "total time"
 * is what the acceptance criterion asks for.
 */
export async function guardedFetch(
  raw: string,
  { maxBytes, timeoutMs }: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const signal = AbortSignal.timeout(timeoutMs)
  let target = raw.trim()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const refusal = urlRefusal(target)
    if (refusal !== null) return { ok: false, kind: 'refused', reason: refusal }

    let res: Response
    try {
      res = await fetch(target, {
        redirect: 'manual',
        signal,
        headers: {
          // Named honestly. A server that would rather not be read by a
          // self-hosted archiver can say so in robots.txt or in a 403, and
          // a pretend browser string would make that impossible.
          'user-agent': 'Spaces/1.0 (+self-hosted document clipper)',
          accept:
            'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
        },
      })
    } catch (err) {
      return {
        ok: false,
        kind: 'network',
        reason: signal.aborted
          ? `The page did not answer within ${String(timeoutMs)}ms.`
          : `Could not reach ${target}: ${messageOf(err)}`,
      }
    }

    if (isRedirect(res.status)) {
      const location = res.headers.get('location')
      if (location === null)
        return {
          ok: false,
          kind: 'network',
          reason: `${target} answered ${String(res.status)} with no Location header.`,
        }
      // Relative, per RFC 7231: `Location: /article` is the ordinary case.
      const next = parsed(new URL(location, target).toString())
      if (next === null)
        return {
          ok: false,
          kind: 'network',
          reason: `${target} redirected to “${location}”, which is not a URL.`,
        }
      target = next.toString()
      continue
    }

    if (!res.ok)
      return {
        ok: false,
        kind: 'network',
        reason: `${target} answered ${String(res.status)}.`,
      }

    const read = await readCapped(res, maxBytes).catch((err: unknown) => ({
      reason: signal.aborted
        ? `The page did not finish within ${String(timeoutMs)}ms.`
        : `Could not read ${target}: ${messageOf(err)}`,
    }))
    if ('reason' in read)
      return { ok: false, kind: 'refused', reason: read.reason }

    return {
      ok: true,
      url: target,
      status: res.status,
      contentType: res.headers.get('content-type'),
      bytes: read.bytes,
    }
  }

  return {
    ok: false,
    kind: 'refused',
    reason: `More than ${String(MAX_REDIRECTS)} redirects — the page never settled.`,
  }
}
