import { describe, expect, it } from 'vitest'
import {
  BOX_API,
  BOX_AUTHORIZE_URL,
  BOX_OAUTH,
  FAKE_BOX_CREDENTIALS,
  makeFakeBoxApi,
} from './fake-box-api.ts'
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
