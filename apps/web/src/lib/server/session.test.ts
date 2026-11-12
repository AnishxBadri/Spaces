import { Effect, Exit } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Forbidden,
  Unauthorized,
  requireAdmin,
  requireAdminProgram,
  requireSettingsReader,
  requireUser,
  requireUserProgram,
} from './shared'

/**
 * The session gate. Only the request and the session lookup are stubbed; a
 * client reads `message` and nothing else, so each rejection is checked on
 * its class and on its message.
 */

const session: { current: { id: string; role: string } | null } = {
  current: null,
}

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('http://localhost/today'),
}))

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

beforeEach(() => {
  session.current = null
})

describe('requireUser', () => {
  it('rejects without a session with Unauthorized, message Unauthorized', async () => {
    const refused = requireUser()
    await expect(refused).rejects.toBeInstanceOf(Unauthorized)
    await expect(refused).rejects.toThrow('Unauthorized')
    await expect(refused).rejects.toMatchObject({
      _tag: 'Unauthorized',
      message: 'Unauthorized',
    })
  })

  it('answers the session user', async () => {
    session.current = { id: 'u1', role: 'member' }
    await expect(requireUser()).resolves.toEqual({ id: 'u1', role: 'member' })
  })

  it('has a twin that fails in the error channel', async () => {
    const exit = await Effect.runPromiseExit(requireUserProgram())
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(Exit.findErrorOption(exit)).toMatchObject({
        value: { _tag: 'Unauthorized' },
      })
  })
})

describe('requireAdmin', () => {
  it('rejects a member with Forbidden, message Admins only', async () => {
    session.current = { id: 'u1', role: 'member' }
    const refused = requireAdmin()
    await expect(refused).rejects.toBeInstanceOf(Forbidden)
    await expect(refused).rejects.toThrow('Admins only')
    await expect(refused).rejects.toMatchObject({
      _tag: 'Forbidden',
      message: 'Admins only',
    })
  })

  it('rejects no session with Unauthorized before asking the role', async () => {
    await expect(requireAdmin()).rejects.toBeInstanceOf(Unauthorized)
  })

  it('answers an admin', async () => {
    session.current = { id: 'a1', role: 'admin' }
    await expect(requireAdmin()).resolves.toEqual({ id: 'a1', role: 'admin' })
    await expect(Effect.runPromise(requireAdminProgram())).resolves.toEqual({
      id: 'a1',
      role: 'admin',
    })
  })
})

describe('requireSettingsReader', () => {
  it('tells a member from an admin and refuses no session', async () => {
    session.current = { id: 'u1', role: 'member' }
    await expect(requireSettingsReader()).resolves.toEqual({ isAdmin: false })
    session.current = { id: 'a1', role: 'admin' }
    await expect(requireSettingsReader()).resolves.toEqual({ isAdmin: true })
    session.current = null
    await expect(requireSettingsReader()).rejects.toThrow('Unauthorized')
  })
})
