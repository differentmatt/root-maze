import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/dynamo.js', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
  queryPrefix: vi.fn(),
}))
// appendLog and membershipKey come from groups; stub the log, keep the key real
// shape so assertions read naturally.
vi.mock('../lib/groups.js', () => ({
  appendLog: vi.fn(),
  membershipKey: (groupId, accountId) => ({
    PK: `GROUP#${groupId}`,
    SK: `MEMBER#${accountId}`,
  }),
}))

import { getItem, putItem, queryPrefix } from '../lib/dynamo.js'
import { appendLog } from '../lib/groups.js'
import {
  linkedNodeMap,
  linkAccountToNode,
  unlinkAccount,
} from '../lib/links.js'

const liveMember = { accountId: 'acc_1', role: 'editor', deletedAt: null }

beforeEach(() => {
  vi.mocked(getItem).mockReset()
  vi.mocked(putItem).mockReset().mockResolvedValue(true)
  vi.mocked(queryPrefix).mockReset().mockResolvedValue([])
  vi.mocked(appendLog).mockReset().mockResolvedValue(undefined)
})

describe('linkedNodeMap', () => {
  it('maps linked accounts to their live nodes and skips unlinked/deleted', async () => {
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { nodeId: 'nod_1', name: 'Ada', accountId: 'acc_1', deletedAt: null },
      { nodeId: 'nod_2', name: 'Bo', accountId: null, deletedAt: null },
      { nodeId: 'nod_3', name: 'Gone', accountId: 'acc_9', deletedAt: 'now' },
    ])
    const map = await linkedNodeMap('g1')
    expect(map).toEqual({ acc_1: { nodeId: 'nod_1', name: 'Ada' } })
  })
})

describe('linkAccountToNode', () => {
  it('rejects a non-member target', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null) // membership lookup
    expect(await linkAccountToNode('g1', 'acc_1', 'acc_1', 'nod_1')).toBe(
      'not_found_member',
    )
    expect(putItem).not.toHaveBeenCalled()
  })

  it('404s a missing node', async () => {
    vi.mocked(getItem)
      .mockResolvedValueOnce(liveMember) // membership
      .mockResolvedValueOnce(null) // node
    expect(await linkAccountToNode('g1', 'acc_1', 'acc_1', 'nod_x')).toBe(
      'not_found_node',
    )
  })

  it('conflicts when the node is claimed by another account', async () => {
    vi.mocked(getItem)
      .mockResolvedValueOnce(liveMember)
      .mockResolvedValueOnce({ nodeId: 'nod_1', name: 'Ada', accountId: 'acc_2', deletedAt: null })
    expect(await linkAccountToNode('g1', 'acc_1', 'acc_1', 'nod_1')).toBe('conflict')
    expect(putItem).not.toHaveBeenCalled()
  })

  it('is an idempotent no-op when already linked to that node', async () => {
    vi.mocked(getItem)
      .mockResolvedValueOnce(liveMember)
      .mockResolvedValueOnce({ nodeId: 'nod_1', name: 'Ada', accountId: 'acc_1', deletedAt: null })
    const res = await linkAccountToNode('g1', 'acc_1', 'acc_1', 'nod_1')
    expect(res).toEqual({ status: 'ok', nodeId: 'nod_1' })
    expect(putItem).not.toHaveBeenCalled()
  })

  it('links a free node and logs it', async () => {
    vi.mocked(getItem)
      .mockResolvedValueOnce(liveMember)
      .mockResolvedValueOnce({ PK: 'GROUP#g1', SK: 'NODE#nod_1', nodeId: 'nod_1', name: 'Ada', accountId: null, deletedAt: null })
    // liveNodes scan (for the "move" step) — only the target, already unlinked.
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { nodeId: 'nod_1', name: 'Ada', accountId: null, deletedAt: null },
    ])

    const res = await linkAccountToNode('g1', 'acc_1', 'acc_1', 'nod_1')
    expect(res).toEqual({ status: 'ok', nodeId: 'nod_1' })

    const written = vi.mocked(putItem).mock.calls.map((c) => c[0])
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ nodeId: 'nod_1', accountId: 'acc_1', updatedBy: 'acc_1' })
    expect(appendLog).toHaveBeenCalledWith(
      'g1', 'acc_1', 'link', 'node', 'nod_1',
      { nodeId: 'nod_1', accountId: null },
      { nodeId: 'nod_1', accountId: 'acc_1' },
    )
  })

  it('moves the link off any other node the account already holds', async () => {
    vi.mocked(getItem)
      .mockResolvedValueOnce(liveMember)
      .mockResolvedValueOnce({ nodeId: 'nod_2', name: 'Bo', accountId: null, deletedAt: null })
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { nodeId: 'nod_1', name: 'Old', accountId: 'acc_1', deletedAt: null },
      { nodeId: 'nod_2', name: 'Bo', accountId: null, deletedAt: null },
    ])

    const res = await linkAccountToNode('g1', 'acc_1', 'acc_1', 'nod_2')
    expect(res).toEqual({ status: 'ok', nodeId: 'nod_2' })

    const written = vi.mocked(putItem).mock.calls.map((c) => c[0])
    // nod_1 cleared, then nod_2 linked.
    expect(written[0]).toMatchObject({ nodeId: 'nod_1', accountId: null })
    expect(written[1]).toMatchObject({ nodeId: 'nod_2', accountId: 'acc_1' })
    expect(appendLog).toHaveBeenCalledWith(
      'g1', 'acc_1', 'unlink', 'node', 'nod_1',
      { nodeId: 'nod_1', accountId: 'acc_1' },
      { nodeId: 'nod_1', accountId: null },
    )
  })
})

describe('unlinkAccount', () => {
  it('returns not_found when the account holds no node', async () => {
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { nodeId: 'nod_1', accountId: 'acc_2', deletedAt: null },
    ])
    expect(await unlinkAccount('g1', 'acc_1', 'acc_1')).toBe('not_found')
    expect(putItem).not.toHaveBeenCalled()
  })

  it('clears the linked node and logs the unlink', async () => {
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { nodeId: 'nod_1', name: 'Ada', accountId: 'acc_1', deletedAt: null },
    ])
    const res = await unlinkAccount('g1', 'acc_9', 'acc_1')
    expect(res).toEqual({ status: 'ok', nodeId: 'nod_1' })
    expect(vi.mocked(putItem).mock.calls[0][0]).toMatchObject({
      nodeId: 'nod_1',
      accountId: null,
      updatedBy: 'acc_9',
    })
    expect(appendLog).toHaveBeenCalledWith(
      'g1', 'acc_9', 'unlink', 'node', 'nod_1',
      { nodeId: 'nod_1', accountId: 'acc_1' },
      { nodeId: 'nod_1', accountId: null },
    )
  })
})
