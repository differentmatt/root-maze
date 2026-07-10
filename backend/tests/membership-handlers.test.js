import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/http.js', () => ({ requireGroupMember: vi.fn() }))
vi.mock('../lib/auth.js', () => ({ authenticate: vi.fn() }))
vi.mock('../lib/accounts.js', () => ({ resolveAccount: vi.fn() }))
vi.mock('../lib/groups.js', () => ({
  listMembers: vi.fn(),
  removeMember: vi.fn(),
  changeMemberRole: vi.fn(),
}))
vi.mock('../lib/invites.js', () => ({
  createInvite: vi.fn(),
  listInvites: vi.fn(),
  revokeInvite: vi.fn(),
  previewInvite: vi.fn(),
  acceptInvite: vi.fn(),
}))

import { requireGroupMember } from '../lib/http.js'
import { authenticate } from '../lib/auth.js'
import { resolveAccount } from '../lib/accounts.js'
import { listMembers, removeMember, changeMemberRole } from '../lib/groups.js'
import {
  createInvite,
  listInvites,
  revokeInvite,
  previewInvite,
  acceptInvite,
} from '../lib/invites.js'
import { handler as membersHandler } from '../handlers/members.js'
import { handler as invitesHandler } from '../handlers/invites.js'

const member = { account: { accountId: 'acc_1' } }

beforeEach(() => {
  vi.clearAllMocks()
})

function event({ method, path = {}, body } = {}) {
  return {
    pathParameters: path,
    requestContext: { http: { method } },
    body: body ? JSON.stringify(body) : undefined,
  }
}

describe('members handler', () => {
  it('403s when not a group member', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce({
      response: { statusCode: 403, body: '{}' },
    })
    const res = await membersHandler(event({ method: 'GET', path: { groupId: 'g1' } }))
    expect(res.statusCode).toBe(403)
  })

  it('lists members with the caller marked', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce(member)
    vi.mocked(listMembers).mockResolvedValueOnce([{ accountId: 'acc_1', role: 'owner' }])
    const res = await membersHandler(event({ method: 'GET', path: { groupId: 'g1' } }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      members: [{ accountId: 'acc_1', role: 'owner' }],
      me: 'acc_1',
    })
  })

  it('409s when removing the last owner', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce(member)
    vi.mocked(removeMember).mockResolvedValueOnce('last_owner')
    const res = await membersHandler(
      event({ method: 'DELETE', path: { groupId: 'g1', accountId: 'acc_1' } }),
    )
    expect(res.statusCode).toBe(409)
  })

  it('removes a member', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce(member)
    vi.mocked(removeMember).mockResolvedValueOnce('ok')
    const res = await membersHandler(
      event({ method: 'DELETE', path: { groupId: 'g1', accountId: 'acc_2' } }),
    )
    expect(res.statusCode).toBe(200)
    expect(removeMember).toHaveBeenCalledWith('g1', 'acc_1', 'acc_2')
  })

  it('changes a role', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce(member)
    vi.mocked(changeMemberRole).mockResolvedValueOnce({ status: 'ok', role: 'owner' })
    const res = await membersHandler(
      event({ method: 'PATCH', path: { groupId: 'g1', accountId: 'acc_2' }, body: { role: 'owner' } }),
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ accountId: 'acc_2', role: 'owner' })
  })
})

describe('invites handler — management', () => {
  it('creates an invite for a member', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce(member)
    vi.mocked(createInvite).mockResolvedValueOnce({ token: 'tok', role: 'editor' })
    const res = await invitesHandler(event({ method: 'POST', path: { groupId: 'g1' } }))
    expect(res.statusCode).toBe(200)
    expect(createInvite).toHaveBeenCalledWith('g1', 'acc_1', {})
  })

  it('lists invites', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce(member)
    vi.mocked(listInvites).mockResolvedValueOnce([{ token: 'tok' }])
    const res = await invitesHandler(event({ method: 'GET', path: { groupId: 'g1' } }))
    expect(JSON.parse(res.body)).toEqual({ invites: [{ token: 'tok' }] })
  })

  it('revokes an invite', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce(member)
    vi.mocked(revokeInvite).mockResolvedValueOnce(true)
    const res = await invitesHandler(
      event({ method: 'DELETE', path: { groupId: 'g1', token: 'tok' } }),
    )
    expect(res.statusCode).toBe(200)
  })
})

describe('invites handler — token routes', () => {
  it('previews without auth', async () => {
    vi.mocked(previewInvite).mockResolvedValueOnce({ valid: true, groupName: 'Fam' })
    const res = await invitesHandler(event({ method: 'GET', path: { token: 'tok' } }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ valid: true, groupName: 'Fam' })
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('401s accepting without a token', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce(null)
    const res = await invitesHandler(event({ method: 'POST', path: { token: 'tok' } }))
    expect(res.statusCode).toBe(401)
  })

  it('410s accepting an invalid invite', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce({ sub: 's' })
    vi.mocked(resolveAccount).mockResolvedValueOnce({ accountId: 'acc_9' })
    vi.mocked(acceptInvite).mockResolvedValueOnce({ ok: false })
    const res = await invitesHandler(event({ method: 'POST', path: { token: 'tok' } }))
    expect(res.statusCode).toBe(410)
  })

  it('accepts a valid invite', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce({ sub: 's' })
    vi.mocked(resolveAccount).mockResolvedValueOnce({ accountId: 'acc_9' })
    vi.mocked(acceptInvite).mockResolvedValueOnce({
      ok: true,
      groupId: 'g1',
      name: 'Fam',
      role: 'editor',
    })
    const res = await invitesHandler(event({ method: 'POST', path: { token: 'tok' } }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ groupId: 'g1', name: 'Fam', role: 'editor' })
    expect(acceptInvite).toHaveBeenCalledWith('acc_9', 'tok')
  })
})
