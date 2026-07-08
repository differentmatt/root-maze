import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/dynamo.js', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
  queryIndexPrefix: vi.fn(),
}))

import { getItem, putItem, queryIndexPrefix } from '../lib/dynamo.js'
import {
  requireMember,
  listGroupsForAccount,
  createGroup,
  ForbiddenError,
} from '../lib/groups.js'

describe('requireMember', () => {
  beforeEach(() => {
    vi.mocked(getItem).mockReset()
  })

  it('allows an active member', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({ role: 'owner', deletedAt: null })
    await expect(requireMember('g1', 'acc_1')).resolves.toBeTruthy()
  })

  it('rejects a non-member', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null)
    await expect(requireMember('g1', 'acc_x')).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('rejects a soft-deleted member', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      role: 'owner',
      deletedAt: '2026-01-01T00:00:00Z',
    })
    await expect(requireMember('g1', 'acc_1')).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })
})

describe('listGroupsForAccount', () => {
  beforeEach(() => {
    vi.mocked(getItem).mockReset()
    vi.mocked(queryIndexPrefix).mockReset()
  })

  it('joins memberships to group names and skips deleted groups', async () => {
    vi.mocked(queryIndexPrefix).mockResolvedValueOnce([
      { groupId: 'g1', role: 'owner', deletedAt: null },
      { groupId: 'g2', role: 'editor', deletedAt: null },
    ])
    vi.mocked(getItem)
      .mockResolvedValueOnce({ name: 'The Lotts', deletedAt: null })
      .mockResolvedValueOnce({ name: 'Gone', deletedAt: '2026-01-01' })

    const groups = await listGroupsForAccount('acc_1')

    expect(groups).toEqual([{ groupId: 'g1', name: 'The Lotts', role: 'owner' }])
  })
})

describe('createGroup', () => {
  beforeEach(() => {
    vi.mocked(putItem).mockReset().mockResolvedValue(true)
  })

  it('writes group meta, an owner membership with GSI keys, and a log entry', async () => {
    const group = await createGroup('acc_1', 'The Lotts')

    expect(group).toMatchObject({ name: 'The Lotts', role: 'owner' })
    expect(group.groupId).toMatch(/^grp_/)
    expect(putItem).toHaveBeenCalledTimes(3)

    const membership = vi
      .mocked(putItem)
      .mock.calls.map((c) => c[0])
      .find((i) => typeof i.SK === 'string' && i.SK.startsWith('MEMBER#'))
    expect(membership.role).toBe('owner')
    expect(membership.GSI1PK).toBe('ACCOUNT#acc_1')
    expect(membership.GSI1SK).toBe(`GROUP#${group.groupId}`)

    const log = vi
      .mocked(putItem)
      .mock.calls.map((c) => c[0])
      .find((i) => typeof i.SK === 'string' && i.SK.startsWith('LOG#'))
    expect(log.action).toBe('create')
    expect(log.entityType).toBe('group')
  })
})
