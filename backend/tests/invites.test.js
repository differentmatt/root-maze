import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/dynamo.js', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
  queryPrefix: vi.fn(),
  queryIndexPrefix: vi.fn(),
}))

vi.mock('../lib/groups.js', () => ({
  appendLog: vi.fn(),
  addMember: vi.fn(),
  groupMetaKey: (id) => ({ PK: `GROUP#${id}`, SK: 'META' }),
}))

import { getItem, putItem, queryPrefix, queryIndexPrefix } from '../lib/dynamo.js'
import { appendLog, addMember } from '../lib/groups.js'
import {
  createInvite,
  listInvites,
  revokeInvite,
  previewInvite,
  acceptInvite,
} from '../lib/invites.js'
import { ValidationError } from '../lib/errors.js'

const future = () => new Date(Date.now() + 60_000).toISOString()
const past = () => new Date(Date.now() - 60_000).toISOString()

beforeEach(() => {
  vi.mocked(getItem).mockReset()
  vi.mocked(putItem).mockReset().mockResolvedValue(true)
  vi.mocked(queryPrefix).mockReset()
  vi.mocked(queryIndexPrefix).mockReset()
  vi.mocked(appendLog).mockReset()
  vi.mocked(addMember).mockReset()
})

describe('createInvite', () => {
  it('mints a token, GSI keys, an editor role and a future expiry', async () => {
    const invite = await createInvite('g1', 'acc_1', {})

    expect(invite.token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(invite.role).toBe('editor')
    expect(invite.useCount).toBe(0)
    expect(new Date(invite.expiresAt).getTime()).toBeGreaterThan(Date.now())

    const write = vi.mocked(putItem).mock.calls[0][0]
    expect(write.GSI1PK).toBe(`INVITE#${invite.token}`)
    expect(write.GSI1SK).toBe('GROUP#g1')
    expect(appendLog).toHaveBeenCalledWith(
      'g1',
      'acc_1',
      'create',
      'invite',
      invite.token,
      null,
      expect.objectContaining({ role: 'editor' }),
    )
  })

  it('rejects a non-positive maxUses', async () => {
    await expect(createInvite('g1', 'acc_1', { maxUses: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('honours a max-use cap', async () => {
    const invite = await createInvite('g1', 'acc_1', { maxUses: 3 })
    expect(invite.maxUses).toBe(3)
  })
})

describe('listInvites', () => {
  it('returns only live invites (drops expired/revoked/used-up)', async () => {
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { token: 't1', expiresAt: future(), useCount: 0, deletedAt: null },
      { token: 't2', expiresAt: past(), useCount: 0, deletedAt: null },
      { token: 't3', expiresAt: future(), useCount: 0, deletedAt: 'gone' },
      { token: 't4', expiresAt: future(), maxUses: 2, useCount: 2, deletedAt: null },
    ])
    const invites = await listInvites('g1')
    expect(invites.map((i) => i.token)).toEqual(['t1'])
  })
})

describe('revokeInvite', () => {
  it('returns false for an unknown token', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null)
    expect(await revokeInvite('g1', 'acc_1', 'nope')).toBe(false)
  })

  it('soft-deletes and logs', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      PK: 'GROUP#g1',
      SK: 'INVITE#t1',
      token: 't1',
      deletedAt: null,
    })
    expect(await revokeInvite('g1', 'acc_1', 't1')).toBe(true)
    expect(vi.mocked(putItem).mock.calls[0][0].deletedAt).toBeTruthy()
    expect(appendLog).toHaveBeenCalledWith('g1', 'acc_1', 'delete', 'invite', 't1', expect.anything(), null)
  })
})

describe('previewInvite', () => {
  it('is invalid for an expired token', async () => {
    vi.mocked(queryIndexPrefix).mockResolvedValueOnce([
      { token: 't1', groupId: 'g1', expiresAt: past() },
    ])
    expect(await previewInvite('t1')).toEqual({ valid: false })
  })

  it('is invalid for an unknown token', async () => {
    vi.mocked(queryIndexPrefix).mockResolvedValueOnce([])
    expect(await previewInvite('nope')).toEqual({ valid: false })
  })

  it('is invalid when the group is soft-deleted', async () => {
    vi.mocked(queryIndexPrefix).mockResolvedValueOnce([
      { token: 't1', groupId: 'g1', expiresAt: future() },
    ])
    vi.mocked(getItem).mockResolvedValueOnce({ name: 'Gone', deletedAt: 'x' })
    expect(await previewInvite('t1')).toEqual({ valid: false })
  })

  it('reveals only the group name for a valid token', async () => {
    vi.mocked(queryIndexPrefix).mockResolvedValueOnce([
      { token: 't1', groupId: 'g1', expiresAt: future() },
    ])
    vi.mocked(getItem).mockResolvedValueOnce({ name: 'The Lotts', deletedAt: null })
    expect(await previewInvite('t1')).toEqual({ valid: true, groupName: 'The Lotts' })
  })
})

describe('acceptInvite', () => {
  it('fails for an expired invite', async () => {
    vi.mocked(queryIndexPrefix).mockResolvedValueOnce([
      { token: 't1', groupId: 'g1', expiresAt: past() },
    ])
    expect(await acceptInvite('acc_9', 't1')).toEqual({ ok: false })
    expect(addMember).not.toHaveBeenCalled()
  })

  it('adds the caller and consumes a use on a fresh join', async () => {
    vi.mocked(queryIndexPrefix).mockResolvedValueOnce([
      { token: 't1', groupId: 'g1', role: 'editor', expiresAt: future(), useCount: 0 },
    ])
    vi.mocked(getItem)
      .mockResolvedValueOnce({ name: 'The Lotts', deletedAt: null }) // group meta
      .mockResolvedValueOnce({ token: 't1', useCount: 0, deletedAt: null }) // fresh invite for increment
    vi.mocked(addMember).mockResolvedValueOnce({ role: 'editor', added: true })

    const result = await acceptInvite('acc_9', 't1')
    expect(result).toMatchObject({ ok: true, groupId: 'g1', name: 'The Lotts', role: 'editor' })
    expect(addMember).toHaveBeenCalledWith('g1', 'acc_9', 'acc_9', 'editor')
    const increment = vi.mocked(putItem).mock.calls.find((c) => c[0].token === 't1')
    expect(increment[0].useCount).toBe(1)
  })

  it('is an idempotent no-op when already a member (no extra use consumed)', async () => {
    vi.mocked(queryIndexPrefix).mockResolvedValueOnce([
      { token: 't1', groupId: 'g1', role: 'editor', expiresAt: future(), useCount: 0 },
    ])
    vi.mocked(getItem).mockResolvedValueOnce({ name: 'The Lotts', deletedAt: null })
    vi.mocked(addMember).mockResolvedValueOnce({ role: 'owner', added: false })

    const result = await acceptInvite('acc_1', 't1')
    expect(result).toMatchObject({ ok: true, role: 'owner', added: false })
    expect(putItem).not.toHaveBeenCalled()
    expect(appendLog).not.toHaveBeenCalled()
  })
})
