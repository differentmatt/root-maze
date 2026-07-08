import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/auth.js', () => ({ authenticate: vi.fn() }))
vi.mock('../lib/accounts.js', () => ({ resolveAccount: vi.fn() }))
vi.mock('../lib/groups.js', () => ({
  listGroupsForAccount: vi.fn(),
  createGroup: vi.fn(),
}))

import { authenticate } from '../lib/auth.js'
import { resolveAccount } from '../lib/accounts.js'
import { listGroupsForAccount, createGroup } from '../lib/groups.js'
import { handler as meHandler } from '../handlers/me.js'
import { handler as groupsHandler } from '../handlers/groups.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/me', () => {
  it('401s without a valid token', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce(null)
    const res = await meHandler({ headers: {} })
    expect(res.statusCode).toBe(401)
  })

  it('returns account + groups for an authenticated caller', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce({ sub: 'g1', email: 'a@b.com' })
    vi.mocked(resolveAccount).mockResolvedValueOnce({
      accountId: 'acc_1',
      email: 'a@b.com',
    })
    vi.mocked(listGroupsForAccount).mockResolvedValueOnce([
      { groupId: 'g1', name: 'Fam', role: 'owner' },
    ])

    const res = await meHandler({ headers: { authorization: 'Bearer x' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.accountId).toBe('acc_1')
    expect(body.groups).toHaveLength(1)
  })
})

describe('POST /api/groups', () => {
  const post = (body) => ({
    headers: { authorization: 'Bearer x' },
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
  })

  it('401s without a valid token', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce(null)
    const res = await groupsHandler(post({ name: 'Fam' }))
    expect(res.statusCode).toBe(401)
  })

  it('400s on an empty name', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce({ sub: 'g1' })
    const res = await groupsHandler(post({ name: '   ' }))
    expect(res.statusCode).toBe(400)
  })

  it('creates a group for an authenticated caller', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce({ sub: 'g1' })
    vi.mocked(resolveAccount).mockResolvedValueOnce({ accountId: 'acc_1' })
    vi.mocked(createGroup).mockResolvedValueOnce({
      groupId: 'grp_1',
      name: 'Fam',
      role: 'owner',
    })

    const res = await groupsHandler(post({ name: 'Fam' }))
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(createGroup)).toHaveBeenCalledWith('acc_1', 'Fam')
  })
})
