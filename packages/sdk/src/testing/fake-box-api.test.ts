import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BOX_API,
  BOX_AUTHORIZE_URL,
  BOX_OAUTH,
  BOX_UPLOAD,
  FAKE_BOX_CREDENTIALS,
  FAKE_BOX_SEED,
  makeFakeBoxApi,
  sha1Hex,
} from './fake-box-api.ts'
import { FAKE_DRIVE_SEED } from './fake-drive.ts'
import type { FakeBoxApi } from './fake-box-api.ts'

/** The fake Box on its own: the traps a Box plugin and the connect dance must meet. */

const get = (api: FakeBoxApi, url: string, token = api.accessToken) =>
  api.fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  })

const post = (api: FakeBoxApi, form: Record<string, string>) =>
  api.fetch(`${BOX_OAUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: FAKE_BOX_CREDENTIALS.clientId,
      client_secret: FAKE_BOX_CREDENTIALS.clientSecret,
      ...form,
    }).toString(),
  })

const refresh = (api: FakeBoxApi, refreshToken: string) =>
  post(api, { grant_type: 'refresh_token', refresh_token: refreshToken })

describe('the fake Box’s OAuth', () => {
  it('trades a code once, and rotates the refresh token on every use', async () => {
    const api = makeFakeBoxApi()
    const authorized = await api.fetch(
      `${BOX_AUTHORIZE_URL}?response_type=code&client_id=${FAKE_BOX_CREDENTIALS.clientId}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=s1`,
      { method: 'GET', headers: {} },
    )
    const back = new URL(authorized.headers.get('location') ?? '')
    expect(back.searchParams.get('state')).toBe('s1')
    const code = back.searchParams.get('code') ?? ''
    const first = await post(api, { grant_type: 'authorization_code', code })
    expect(first.status).toBe(200)
    const grant: unknown = await first.json()
    expect(grant).toMatchObject({ token_type: 'bearer', expires_in: 3600 })
    expect(grant).not.toHaveProperty('scope')
    expect(
      (await post(api, { grant_type: 'authorization_code', code })).status,
    ).toBe(400)

    const rotated = await refresh(api, FAKE_BOX_CREDENTIALS.refreshToken)
    expect(rotated.status).toBe(200)
    const spent = await refresh(api, FAKE_BOX_CREDENTIALS.refreshToken)
    expect(spent.status).toBe(400)
    expect(await spent.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Invalid refresh token',
    })
    expect(api.oauth.liveRefreshTokens()).not.toContain(
      FAKE_BOX_CREDENTIALS.refreshToken,
    )
  })

  it('a lapsed grant refuses its refresh token', async () => {
    const api = makeFakeBoxApi()
    api.oauth.lapse()
    const answer = await refresh(api, FAKE_BOX_CREDENTIALS.refreshToken)
    expect(await answer.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Refresh token has expired',
    })
  })

  it('refuses a client it does not know', async () => {
    const api = makeFakeBoxApi()
    const answer = await api.fetch(`${BOX_OAUTH}/token`, {
      method: 'POST',
      headers: {},
      body: 'grant_type=refresh_token&client_id=x&client_secret=y',
    })
    expect(await answer.json()).toMatchObject({ error: 'invalid_client' })
  })
})

describe('the fake Box’s content API', () => {
  it('lists Box’s mini objects unless fields are asked for', async () => {
    const api = makeFakeBoxApi()
    const bare: unknown = await (
      await get(api, `${BOX_API}/folders/1001/items`)
    ).json()
    expect(bare).toMatchObject({
      entries: expect.arrayContaining([
        expect.not.objectContaining({ size: expect.anything() }),
      ]),
    })
    const asked: unknown = await (
      await get(api, `${BOX_API}/folders/1001/items?fields=size`)
    ).json()
    expect(asked).toMatchObject({
      entries: expect.arrayContaining([{ type: 'file', id: '2002', size: 23 }]),
    })
  })

  it('refuses a token it never issued, and answers a revoked connection 401', async () => {
    const api = makeFakeBoxApi()
    expect((await get(api, `${BOX_API}/folders/0`, 'forged')).status).toBe(401)
    api.chaos.revoke()
    expect((await get(api, `${BOX_API}/folders/0`)).status).toBe(401)
    api.chaos.restore()
    expect((await get(api, `${BOX_API}/folders/0`)).status).toBe(200)
  })
})

describe('the fake Box’s events stream', () => {
  it('writes a 64-bit position unquoted, and a position older than the window is a 400', async () => {
    const api = makeFakeBoxApi()
    const text = await (
      await get(api, `${BOX_API}/events?stream_position=now`)
    ).text()
    const position = /"next_stream_position":(\d+)[,}]/.exec(text)?.[1] ?? ''
    expect(position).toMatch(/^\d{19}$/)
    expect(String(Number(position))).not.toBe(position)

    api.trash('2002')
    const page: unknown = await (
      await get(
        api,
        `${BOX_API}/events?stream_position=${position}&stream_type=changes`,
      )
    ).json()
    expect(page).toMatchObject({
      chunk_size: 1,
      entries: [
        {
          event_type: 'ITEM_TRASH',
          source: { id: '2002', item_status: 'trashed' },
        },
      ],
    })

    api.chaos.evictCursors()
    const stale = await get(
      api,
      `${BOX_API}/events?stream_position=${position}&stream_type=changes`,
    )
    expect(stale.status).toBe(400)
  })
})

const send = (
  api: FakeBoxApi,
  method: string,
  url: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) =>
  api.fetch(url, {
    method,
    headers: { authorization: `Bearer ${api.accessToken}`, ...headers },
    body,
  })

const encoder = new TextEncoder()

/** A multipart body in the order given. */
const multipart = (parts: ReadonlyArray<readonly [string, string]>) => ({
  body: `${parts.map(([name, value]) => `--b\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')}--b--\r\n`,
  headers: { 'content-type': 'multipart/form-data; boundary=b' },
})

describe('the fake Box’s seed', () => {
  it('holds the fake Drive’s fourteen data-room files under the same folder names', () => {
    const named = (
      seed: ReadonlyArray<{
        kind: string
        name: string
        parentId: string | null
        id: string
      }>,
      root: string,
    ) => {
      const folders = new Map(
        seed.filter((i) => i.kind === 'folder').map((i) => [i.id, i]),
      )
      const pathOf = (id: string | null): string | null => {
        if (id === root) return ''
        const folder = id === null ? undefined : folders.get(id)
        if (folder === undefined) return null
        const up = pathOf(folder.parentId)
        return up === null ? null : `${up}/${folder.name}`
      }
      return seed
        .filter((i) => i.kind !== 'folder' && i.kind !== 'web_link')
        .flatMap((i) => {
          const at = pathOf(i.parentId)
          return at === null
            ? []
            : [`${at}/${i.name.replace(/\.boxnote$/, '')}`]
        })
        .sort()
    }
    expect(named(FAKE_BOX_SEED, '1001')).toEqual(
      named(FAKE_DRIVE_SEED, 'dataroom'),
    )
    expect(named(FAKE_BOX_SEED, '1001')).toHaveLength(14)
  })
})

describe('the fake Box’s writes', () => {
  it('sha1Hex is SHA-1', () => {
    for (const text of [
      '',
      'abc',
      'x'.repeat(55),
      'y'.repeat(64),
      'z'.repeat(1000),
    ])
      expect(sha1Hex(encoder.encode(text))).toBe(
        createHash('sha1').update(text).digest('hex'),
      )
  })

  it('a folder create under a taken name is a 409 listing the item in the way, case ignored', async () => {
    const api = makeFakeBoxApi()
    const made = await send(
      api,
      'POST',
      `${BOX_API}/folders`,
      JSON.stringify({ name: 'Diligence', parent: { id: '1001' } }),
    )
    expect(made.status).toBe(201)
    const again = await send(
      api,
      'POST',
      `${BOX_API}/folders`,
      JSON.stringify({ name: 'diligence', parent: { id: '1001' } }),
    )
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({
      code: 'item_name_in_use',
      context_info: { conflicts: [{ type: 'folder', name: 'Diligence' }] },
    })
  })

  it('an upload under a taken name is a 409 naming one file with its sha1', async () => {
    const api = makeFakeBoxApi()
    const { body, headers } = multipart([
      [
        'attributes',
        JSON.stringify({ name: 'Term sheet.pdf', parent: { id: '1002' } }),
      ],
      ['file', 'other bytes'],
    ])
    const answer = await send(
      api,
      'POST',
      `${BOX_UPLOAD}/files/content`,
      body,
      headers,
    )
    expect(answer.status).toBe(409)
    expect(await answer.json()).toMatchObject({
      context_info: {
        conflicts: {
          type: 'file',
          id: '2005',
          sha1: sha1Hex(encoder.encode('%PDF-1.7 Acme term sheet')),
        },
      },
    })
  })

  it('refuses a file part before attributes, and a content-md5 that is not the bytes’ SHA-1', async () => {
    const api = makeFakeBoxApi()
    const attributes = JSON.stringify({
      name: 'New.pdf',
      parent: { id: '1002' },
    })
    const backwards = multipart([
      ['file', 'bytes'],
      ['attributes', attributes],
    ])
    expect(
      (
        await send(
          api,
          'POST',
          `${BOX_UPLOAD}/files/content`,
          backwards.body,
          backwards.headers,
        )
      ).status,
    ).toBe(400)
    const right = multipart([
      ['attributes', attributes],
      ['file', 'bytes'],
    ])
    expect(
      (
        await send(api, 'POST', `${BOX_UPLOAD}/files/content`, right.body, {
          ...right.headers,
          'content-md5': sha1Hex(encoder.encode('other')),
        })
      ).status,
    ).toBe(412)
    const landed = await send(
      api,
      'POST',
      `${BOX_UPLOAD}/files/content`,
      right.body,
      {
        ...right.headers,
        'content-md5': sha1Hex(encoder.encode('bytes')),
      },
    )
    expect(landed.status).toBe(201)
  })

  it('a move or rename is one event; a PUT that changes nothing is none', async () => {
    const api = makeFakeBoxApi()
    const text = await (
      await get(api, `${BOX_API}/events?stream_position=now`)
    ).text()
    const position = /"next_stream_position":(\d+)/.exec(text)?.[1] ?? ''
    const put = (body: object) =>
      send(api, 'PUT', `${BOX_API}/files/2005`, JSON.stringify(body))
    expect((await put({ parent: { id: '1003' } })).status).toBe(200)
    expect((await put({ name: 'Term sheet v2.pdf' })).status).toBe(200)
    expect(
      (await put({ name: 'Term sheet v2.pdf', parent: { id: '1003' } })).status,
    ).toBe(200)
    const page: unknown = await (
      await get(
        api,
        `${BOX_API}/events?stream_position=${position}&stream_type=changes`,
      )
    ).json()
    expect(page).toMatchObject({
      chunk_size: 2,
      entries: [{ event_type: 'ITEM_MOVE' }, { event_type: 'ITEM_RENAME' }],
    })
    expect((await put({ parent: { id: '9999999' } })).status).toBe(404)
  })
})
