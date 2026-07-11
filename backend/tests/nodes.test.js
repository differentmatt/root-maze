import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/dynamo.js', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
  queryPrefix: vi.fn(),
  queryAll: vi.fn(),
}))
// appendLog writes to the log via dynamo; stub it so node tests stay focused.
vi.mock('../lib/groups.js', () => ({ appendLog: vi.fn() }))

import { getItem, putItem, queryPrefix } from '../lib/dynamo.js'
import { appendLog } from '../lib/groups.js'
import {
  listNodes,
  getNode,
  createNode,
  updateNode,
  deleteNode,
} from '../lib/nodes.js'
import { ValidationError } from '../lib/errors.js'

beforeEach(() => {
  vi.mocked(getItem).mockReset()
  vi.mocked(putItem).mockReset().mockResolvedValue(true)
  vi.mocked(queryPrefix).mockReset().mockResolvedValue([])
  vi.mocked(appendLog).mockReset().mockResolvedValue(undefined)
})

describe('listNodes', () => {
  it('drops soft-deleted rows and projects to the public shape', async () => {
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { nodeId: 'nod_1', groupId: 'g1', name: 'Ada', PK: 'x', SK: 'y', deletedAt: null },
      { nodeId: 'nod_2', groupId: 'g1', name: 'Gone', deletedAt: '2026-01-01' },
    ])

    const nodes = await listNodes('g1')

    expect(queryPrefix).toHaveBeenCalledWith('GROUP#g1', 'NODE#')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ nodeId: 'nod_1', name: 'Ada' })
    // No storage internals leak to callers.
    expect(nodes[0]).not.toHaveProperty('PK')
    expect(nodes[0]).not.toHaveProperty('deletedAt')
  })
})

describe('getNode', () => {
  it('returns null for a missing or deleted node', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null)
    expect(await getNode('g1', 'nod_x')).toBeNull()

    vi.mocked(getItem).mockResolvedValueOnce({ nodeId: 'nod_1', deletedAt: 'now' })
    expect(await getNode('g1', 'nod_1')).toBeNull()
  })
})

describe('createNode', () => {
  it('requires a first name', async () => {
    await expect(
      createNode('g1', 'acc_1', { firstName: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(putItem).not.toHaveBeenCalled()
  })

  it('writes a node row with defaults and logs the create', async () => {
    const node = await createNode('g1', 'acc_1', { firstName: '  Ada  ' })

    expect(node.firstName).toBe('Ada')
    expect(node.name).toBe('Ada')
    expect(node.nodeId).toMatch(/^nod_/)
    expect(node.accountId).toBeNull()
    expect(node.birthdate).toBeNull()

    const written = vi.mocked(putItem).mock.calls[0][0]
    expect(written.PK).toBe('GROUP#g1')
    expect(written.SK).toBe(`NODE#${node.nodeId}`)
    expect(written.updatedBy).toBe('acc_1')
    expect(written.deletedAt).toBeNull()
    expect(appendLog).toHaveBeenCalledWith(
      'g1', 'acc_1', 'create', 'node', node.nodeId, null, expect.any(Object),
    )
  })

  it('stores the structured name parts and derives the full name', async () => {
    const node = await createNode('g1', 'acc_1', {
      firstName: '  Ada  ',
      middleName: ' Byron ',
      lastName: ' King ',
      birthName: ' Byron ',
    })

    expect(node.firstName).toBe('Ada')
    expect(node.middleName).toBe('Byron')
    expect(node.lastName).toBe('King')
    expect(node.birthName).toBe('Byron')
    // name is the derived full name (birthName is surfaced as "born …", not here).
    expect(node.name).toBe('Ada Byron King')
  })

  it('collapses blank optional name parts to null', async () => {
    const node = await createNode('g1', 'acc_1', {
      firstName: 'Bo',
      lastName: '   ',
      birthName: '',
    })
    expect(node.lastName).toBeNull()
    expect(node.birthName).toBeNull()
    expect(node.name).toBe('Bo')
  })

  it('ignores accountId on create — linking has its own endpoint', async () => {
    const node = await createNode('g1', 'acc_1', {
      firstName: 'Bo',
      accountId: 'acc_9',
    })
    expect(node.accountId).toBeNull()
  })
})

describe('updateNode', () => {
  it('returns null when the node is gone', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null)
    expect(await updateNode('g1', 'acc_1', 'nod_x', { firstName: 'X' })).toBeNull()
  })

  it('rejects blanking the first name', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      nodeId: 'nod_1', groupId: 'g1', firstName: 'Ada', deletedAt: null,
    })
    await expect(
      updateNode('g1', 'acc_1', 'nod_1', { firstName: '  ' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('migrates a legacy row in place when its name parts are edited', async () => {
    // Legacy row: only `name`, no structured parts. Editing writes the parts and
    // the derived full name follows.
    vi.mocked(getItem).mockResolvedValueOnce({
      PK: 'GROUP#g1', SK: 'NODE#nod_1',
      nodeId: 'nod_1', groupId: 'g1', name: 'Ada', deletedAt: null,
      createdAt: 't0', updatedAt: 't0', updatedBy: 'acc_0',
    })

    const node = await updateNode('g1', 'acc_1', 'nod_1', {
      firstName: 'Ada',
      lastName: 'Lovelace',
    })

    expect(node.firstName).toBe('Ada')
    expect(node.lastName).toBe('Lovelace')
    expect(node.name).toBe('Ada Lovelace')
  })

  it('rejects optional structured parts on a legacy row without a first name', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      PK: 'GROUP#g1', SK: 'NODE#nod_1',
      nodeId: 'nod_1', groupId: 'g1', name: 'Ada Lovelace', deletedAt: null,
      createdAt: 't0', updatedAt: 't0', updatedBy: 'acc_0',
    })

    await expect(
      updateNode('g1', 'acc_1', 'nod_1', { lastName: 'Lovelace' }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(putItem).not.toHaveBeenCalled()
  })

  it('applies only writable fields and stamps updatedBy', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      PK: 'GROUP#g1', SK: 'NODE#nod_1',
      nodeId: 'nod_1', groupId: 'g1', firstName: 'Ada', birthdate: null,
      createdAt: 't0', updatedAt: 't0', updatedBy: 'acc_0', deletedAt: null,
    })

    const node = await updateNode('g1', 'acc_1', 'nod_1', {
      birthdate: '1815',
      nodeId: 'HACK', // not writable — must be ignored
    })

    expect(node.birthdate).toBe('1815')
    expect(node.nodeId).toBe('nod_1')
    expect(node.updatedBy).toBe('acc_1')
    expect(appendLog).toHaveBeenCalledWith(
      'g1', 'acc_1', 'update', 'node', 'nod_1', expect.any(Object), expect.any(Object),
    )
  })
})

describe('deleteNode', () => {
  it('returns false when already gone', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({ nodeId: 'nod_1', deletedAt: 'now' })
    expect(await deleteNode('g1', 'acc_1', 'nod_1')).toBe(false)
  })

  it('soft-deletes the node and cascades to touching edges', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      PK: 'GROUP#g1', SK: 'NODE#nod_1', nodeId: 'nod_1', groupId: 'g1',
      name: 'Ada', deletedAt: null,
    })
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { edgeId: 'edg_1', fromPerson: 'nod_1', toPerson: 'nod_2', deletedAt: null },
      { edgeId: 'edg_2', fromPerson: 'nod_3', toPerson: 'nod_4', deletedAt: null },
      { edgeId: 'edg_3', fromPerson: 'nod_5', toPerson: 'nod_1', deletedAt: null },
    ])

    const ok = await deleteNode('g1', 'acc_1', 'nod_1')
    expect(ok).toBe(true)

    // Node itself + the two edges that reference it (edg_1, edg_3) — not edg_2.
    const deleted = vi
      .mocked(putItem)
      .mock.calls.map((c) => c[0])
      .filter((i) => i.deletedAt)
    expect(deleted.map((i) => i.SK || i.edgeId)).toEqual(
      expect.arrayContaining(['NODE#nod_1', 'edg_1', 'edg_3']),
    )
    expect(deleted.some((i) => i.edgeId === 'edg_2')).toBe(false)
  })
})
