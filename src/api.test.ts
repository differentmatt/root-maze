import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMe, createGroup, ApiError } from './api'
import { setCredential, getCredential } from './auth'

describe('api', () => {
  beforeEach(() => {
    setCredential('test.jwt.token')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('sends the Bearer token on GET /me', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accountId: 'a1', email: null, groups: [] }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const me = await getMe()
    expect(me.accountId).toBe('a1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/me')
    expect(init.headers.Authorization).toBe('Bearer test.jwt.token')
  })

  it('posts a body when creating a group', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ groupId: 'g1', name: 'Fam', role: 'owner' }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const group = await createGroup('Fam')
    expect(group.groupId).toBe('g1')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'Fam' })
  })

  it('clears the credential and throws on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 401 })),
    )
    await expect(getMe()).rejects.toBeInstanceOf(ApiError)
    expect(getCredential()).toBeNull()
  })
})
