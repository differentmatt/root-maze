import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMembers,
  removeMember,
  changeMemberRole,
  getInvites,
  createInvite,
  revokeInvite,
  previewInvite,
  acceptInvite,
  inviteUrl,
} from '../api'
import { setCredential, clearCredential } from '../auth'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('membership + invite api', () => {
  beforeEach(() => setCredential('test.jwt.token'))
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('lists members', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ members: [], me: 'acc_1' }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await getMembers('grp_1')
    expect(res.me).toBe('acc_1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/members')
    expect(init.method).toBe('GET')
  })

  it('removes a member', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ removed: true }))
    vi.stubGlobal('fetch', fetchMock)

    await removeMember('grp_1', 'acc_2')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/members/acc_2')
    expect(init.method).toBe('DELETE')
  })

  it('changes a member role with a body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ accountId: 'acc_2', role: 'owner' }))
    vi.stubGlobal('fetch', fetchMock)

    await changeMemberRole('grp_1', 'acc_2', 'owner')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/members/acc_2')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ role: 'owner' })
  })

  it('creates an invite', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ token: 'tok', role: 'editor' }))
    vi.stubGlobal('fetch', fetchMock)

    await createInvite('grp_1', { maxUses: 5 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/invites')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ maxUses: 5 })
  })

  it('lists invites', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ invites: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await getInvites('grp_1')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/groups/grp_1/invites')
  })

  it('revokes an invite (token url-encoded)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ revoked: true }))
    vi.stubGlobal('fetch', fetchMock)

    await revokeInvite('grp_1', 'a/b+c')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/invites/a%2Fb%2Bc')
    expect(init.method).toBe('DELETE')
  })

  it('previews an invite without requiring a credential', async () => {
    clearCredential()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ valid: true, groupName: 'Fam' }))
    vi.stubGlobal('fetch', fetchMock)

    const preview = await previewInvite('tok')
    expect(preview).toEqual({ valid: true, groupName: 'Fam' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/invites/tok')
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('accepts an invite', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ groupId: 'grp_1', name: 'Fam', role: 'editor' }))
    vi.stubGlobal('fetch', fetchMock)

    await acceptInvite('tok')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/invites/tok/accept')
    expect(init.method).toBe('POST')
  })

  it('builds a shareable invite url from a token', () => {
    expect(inviteUrl('tok')).toContain('/?invite=tok')
  })
})
