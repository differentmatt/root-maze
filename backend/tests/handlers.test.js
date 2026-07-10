import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/auth.js', () => ({ authenticate: vi.fn() }))
vi.mock('../lib/accounts.js', () => ({ resolveAccount: vi.fn() }))
vi.mock('../lib/http.js', () => ({ requireGroupMember: vi.fn() }))
vi.mock('../lib/groups.js', () => ({
  listGroupsForAccount: vi.fn(),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
}))

import { authenticate } from '../lib/auth.js'
import { resolveAccount } from '../lib/accounts.js'
import { requireGroupMember } from '../lib/http.js'
import { listGroupsForAccount, createGroup, renameGroup } from '../lib/groups.js'
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

  it('400s (not 500s) on a malformed JSON body', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce({ sub: 'g1' })
    const res = await groupsHandler({
      headers: { authorization: 'Bearer x' },
      requestContext: { http: { method: 'POST' } },
      body: '{ not json',
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('PATCH /api/groups/{groupId}', () => {
  const patch = (groupId, body) => ({
    headers: { authorization: 'Bearer x' },
    requestContext: { http: { method: 'PATCH' } },
    pathParameters: { groupId },
    body: JSON.stringify(body),
  })

  it('403s a non-member', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce({
      response: { statusCode: 403, body: '{}' },
    })
    const res = await groupsHandler(patch('g1', { name: 'New' }))
    expect(res.statusCode).toBe(403)
  })

  it('renames a group for a member', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce({
      account: { accountId: 'acc_1' },
      member: { role: 'editor' },
    })
    vi.mocked(renameGroup).mockResolvedValueOnce({ groupId: 'g1', name: 'New' })

    const res = await groupsHandler(patch('g1', { name: 'New' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ groupId: 'g1', name: 'New' })
    expect(vi.mocked(renameGroup)).toHaveBeenCalledWith('g1', 'acc_1', 'New')
  })

  it('404s when the group is missing', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce({
      account: { accountId: 'acc_1' },
      member: { role: 'owner' },
    })
    vi.mocked(renameGroup).mockResolvedValueOnce('not_found')
    const res = await groupsHandler(patch('gx', { name: 'New' }))
    expect(res.statusCode).toBe(404)
  })
})
