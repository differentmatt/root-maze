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
  renameGroup,
  ForbiddenError,
} from '../lib/groups.js'
import { ValidationError } from '../lib/errors.js'

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

describe('renameGroup', () => {
  beforeEach(() => {
    vi.mocked(getItem).mockReset()
    vi.mocked(putItem).mockReset().mockResolvedValue(true)
  })

  it('patches the group name and appends an update log', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      PK: 'GROUP#g1',
      SK: 'META',
      groupId: 'g1',
      name: 'Old',
      deletedAt: null,
    })

    const result = await renameGroup('g1', 'acc_1', '  New Name  ')

    expect(result).toEqual({ groupId: 'g1', name: 'New Name' })
    const meta = vi
      .mocked(putItem)
      .mock.calls.map((c) => c[0])
      .find((i) => i.SK === 'META')
    expect(meta.name).toBe('New Name')
    expect(meta.updatedBy).toBe('acc_1')

    const log = vi
      .mocked(putItem)
      .mock.calls.map((c) => c[0])
      .find((i) => typeof i.SK === 'string' && i.SK.startsWith('LOG#'))
    expect(log.action).toBe('update')
    expect(log.entityType).toBe('group')
    expect(log.before).toEqual({ name: 'Old' })
    expect(log.after).toEqual({ name: 'New Name' })
  })

  it('returns not_found for a missing or deleted group', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null)
    expect(await renameGroup('gx', 'acc_1', 'Name')).toBe('not_found')

    vi.mocked(getItem).mockResolvedValueOnce({ name: 'X', deletedAt: '2026-01-01' })
    expect(await renameGroup('gx', 'acc_1', 'Name')).toBe('not_found')
  })

  it('is a no-op write when the name is unchanged', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      SK: 'META',
      groupId: 'g1',
      name: 'Same',
      deletedAt: null,
    })
    const result = await renameGroup('g1', 'acc_1', 'Same')
    expect(result).toEqual({ groupId: 'g1', name: 'Same' })
    expect(putItem).not.toHaveBeenCalled()
  })

  it('rejects an empty or over-long name', async () => {
    await expect(renameGroup('g1', 'acc_1', '   ')).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(renameGroup('g1', 'acc_1', 'x'.repeat(101))).rejects.toBeInstanceOf(
      ValidationError,
    )
  })
})
