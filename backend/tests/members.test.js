import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/dynamo.js', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
  queryPrefix: vi.fn(),
  queryIndexPrefix: vi.fn(),
}))

import { getItem, putItem, queryPrefix } from '../lib/dynamo.js'
import {
  listMembers,
  removeMember,
  changeMemberRole,
  addMember,
} from '../lib/groups.js'
import { ValidationError } from '../lib/errors.js'

beforeEach(() => {
  vi.mocked(getItem).mockReset()
  vi.mocked(putItem).mockReset().mockResolvedValue(true)
  vi.mocked(queryPrefix).mockReset()
})

describe('listMembers', () => {
  it('lists active members enriched with account email/name', async () => {
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { accountId: 'acc_1', role: 'owner', createdAt: 't1', deletedAt: null },
      { accountId: 'acc_2', role: 'editor', createdAt: 't2', deletedAt: null },
      { accountId: 'acc_3', role: 'editor', createdAt: 't3', deletedAt: 'gone' },
    ])
    vi.mocked(getItem)
      .mockResolvedValueOnce({ email: 'a@b.com', name: 'Ann' })
      .mockResolvedValueOnce({ email: 'b@b.com', name: null })

    const members = await listMembers('g1')

    expect(members).toEqual([
      { accountId: 'acc_1', role: 'owner', email: 'a@b.com', name: 'Ann', joinedAt: 't1' },
      { accountId: 'acc_2', role: 'editor', email: 'b@b.com', name: null, joinedAt: 't2' },
    ])
  })
})

describe('removeMember', () => {
  it('404s (not_found) when there is no live membership', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null)
    expect(await removeMember('g1', 'acc_a', 'acc_x')).toBe('not_found')
  })

  it('refuses to remove the last owner', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({ role: 'owner', deletedAt: null })
    vi.mocked(queryPrefix).mockResolvedValueOnce([{ role: 'owner', deletedAt: null }])
    expect(await removeMember('g1', 'acc_a', 'acc_a')).toBe('last_owner')
    expect(putItem).not.toHaveBeenCalled()
  })

  it('soft-deletes a member and logs it', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      PK: 'GROUP#g1',
      SK: 'MEMBER#acc_2',
      role: 'editor',
      deletedAt: null,
    })

    expect(await removeMember('g1', 'acc_1', 'acc_2')).toBe('ok')
    const softDelete = vi.mocked(putItem).mock.calls[0][0]
    expect(softDelete.deletedAt).toBeTruthy()
    expect(softDelete.updatedBy).toBe('acc_1')
    const log = vi
      .mocked(putItem)
      .mock.calls.map((c) => c[0])
      .find((i) => typeof i.SK === 'string' && i.SK.startsWith('LOG#'))
    expect(log.action).toBe('delete')
    expect(log.entityType).toBe('member')
  })

  it('allows removing an owner when another owner remains', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({ role: 'owner', deletedAt: null })
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { role: 'owner', deletedAt: null },
      { role: 'owner', deletedAt: null },
    ])
    expect(await removeMember('g1', 'acc_a', 'acc_b')).toBe('ok')
  })
})

describe('changeMemberRole', () => {
  it('rejects an invalid role', async () => {
    await expect(changeMemberRole('g1', 'acc_a', 'acc_b', 'admin')).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('refuses to demote the last owner', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({ role: 'owner', deletedAt: null })
    vi.mocked(queryPrefix).mockResolvedValueOnce([{ role: 'owner', deletedAt: null }])
    expect(await changeMemberRole('g1', 'acc_a', 'acc_a', 'editor')).toBe('last_owner')
  })

  it('promotes an editor to owner', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      PK: 'GROUP#g1',
      SK: 'MEMBER#acc_2',
      role: 'editor',
      deletedAt: null,
    })
    const result = await changeMemberRole('g1', 'acc_1', 'acc_2', 'owner')
    expect(result).toEqual({ status: 'ok', role: 'owner' })
    const write = vi.mocked(putItem).mock.calls[0][0]
    expect(write.role).toBe('owner')
  })

  it('is a no-op when the role is unchanged', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({ role: 'editor', deletedAt: null })
    const result = await changeMemberRole('g1', 'acc_1', 'acc_2', 'editor')
    expect(result).toEqual({ status: 'ok', role: 'editor' })
    expect(putItem).not.toHaveBeenCalled()
  })
})

describe('addMember', () => {
  it('adds a new membership with GSI reverse-lookup keys', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null)
    const result = await addMember('g1', 'acc_1', 'acc_9', 'editor')
    expect(result).toEqual({ role: 'editor', added: true })
    const write = vi.mocked(putItem).mock.calls[0][0]
    expect(write.GSI1PK).toBe('ACCOUNT#acc_9')
    expect(write.GSI1SK).toBe('GROUP#g1')
    expect(write.role).toBe('editor')
  })

  it('is idempotent when already an active member', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({ role: 'owner', deletedAt: null })
    const result = await addMember('g1', 'acc_1', 'acc_1', 'editor')
    expect(result).toEqual({ role: 'owner', added: false })
    expect(putItem).not.toHaveBeenCalled()
  })

  it('revives a soft-deleted membership', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      role: 'editor',
      createdAt: 'orig',
      deletedAt: 'gone',
    })
    const result = await addMember('g1', 'acc_1', 'acc_2', 'editor')
    expect(result.added).toBe(true)
    const write = vi.mocked(putItem).mock.calls[0][0]
    expect(write.deletedAt).toBeNull()
    expect(write.createdAt).toBe('orig')
  })
})
