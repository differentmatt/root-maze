import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/dynamo.js', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
  queryPrefix: vi.fn(),
}))
vi.mock('../lib/groups.js', () => ({ appendLog: vi.fn() }))
vi.mock('../lib/nodes.js', () => ({ getNode: vi.fn() }))

import { getItem, putItem, queryPrefix } from '../lib/dynamo.js'
import { appendLog } from '../lib/groups.js'
import { getNode } from '../lib/nodes.js'
import {
  listEdges,
  createEdge,
  updateEdge,
  deleteEdge,
  resolveSubtype,
  isValidKind,
} from '../lib/edges.js'
import { ValidationError } from '../lib/errors.js'

beforeEach(() => {
  vi.mocked(getItem).mockReset()
  vi.mocked(putItem).mockReset().mockResolvedValue(true)
  vi.mocked(queryPrefix).mockReset().mockResolvedValue([])
  vi.mocked(appendLog).mockReset().mockResolvedValue(undefined)
  vi.mocked(getNode).mockReset()
})

describe('subtype validation', () => {
  it('accepts valid kinds', () => {
    expect(isValidKind('parent_child')).toBe(true)
    expect(isValidKind('partner')).toBe(true)
    expect(isValidKind('sibling')).toBe(false)
  })

  it('defaults an empty subtype per kind', () => {
    expect(resolveSubtype('parent_child', undefined)).toBe('biological')
    expect(resolveSubtype('partner', '')).toBe('partner')
  })

  it('rejects an unknown subtype for the kind', () => {
    expect(() => resolveSubtype('partner', 'adoptive')).toThrow(ValidationError)
  })
})

describe('createEdge', () => {
  it('rejects an invalid kind', async () => {
    await expect(
      createEdge('g1', 'acc_1', { edgeKind: 'sibling', fromPerson: 'a', toPerson: 'b' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a self-edge', async () => {
    await expect(
      createEdge('g1', 'acc_1', { edgeKind: 'partner', fromPerson: 'a', toPerson: 'a' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects when an endpoint node is missing', async () => {
    vi.mocked(getNode).mockResolvedValueOnce({ nodeId: 'a' }).mockResolvedValueOnce(null)
    await expect(
      createEdge('g1', 'acc_1', {
        edgeKind: 'parent_child', fromPerson: 'a', toPerson: 'b',
      }),
    ).rejects.toThrow(/toPerson does not exist/)
  })

  it('rejects a second relationship between the same two people', async () => {
    vi.mocked(getNode)
      .mockResolvedValueOnce({ nodeId: 'a' })
      .mockResolvedValueOnce({ nodeId: 'b' })
    // An existing edge in the reverse direction still counts as a duplicate.
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { edgeId: 'edg_1', fromPerson: 'b', toPerson: 'a', deletedAt: null },
    ])
    await expect(
      createEdge('g1', 'acc_1', {
        edgeKind: 'partner', fromPerson: 'a', toPerson: 'b',
      }),
    ).rejects.toThrow(/already connected/)
    expect(putItem).not.toHaveBeenCalled()
  })

  it('allows a new edge when the only existing one was soft-deleted', async () => {
    vi.mocked(getNode)
      .mockResolvedValueOnce({ nodeId: 'a' })
      .mockResolvedValueOnce({ nodeId: 'b' })
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      { edgeId: 'edg_old', fromPerson: 'a', toPerson: 'b', deletedAt: 'gone' },
    ])
    const edge = await createEdge('g1', 'acc_1', {
      edgeKind: 'partner', fromPerson: 'a', toPerson: 'b',
    })
    expect(edge.edgeId).toMatch(/^edg_/)
  })

  it('writes an edge with a resolved subtype and logs it', async () => {
    vi.mocked(getNode)
      .mockResolvedValueOnce({ nodeId: 'a' })
      .mockResolvedValueOnce({ nodeId: 'b' })

    const edge = await createEdge('g1', 'acc_1', {
      edgeKind: 'parent_child', fromPerson: 'a', toPerson: 'b', startDate: '2000',
    })

    expect(edge.edgeId).toMatch(/^edg_/)
    expect(edge.edgeKind).toBe('parent_child')
    expect(edge.subtype).toBe('biological')
    expect(edge.startDate).toBe('2000')
    expect(edge.fromPerson).toBe('a')

    const written = vi.mocked(putItem).mock.calls[0][0]
    expect(written.PK).toBe('GROUP#g1')
    expect(written.SK).toBe(`EDGE#${edge.edgeId}`)
    expect(written.deletedAt).toBeNull()
    expect(appendLog).toHaveBeenCalledWith(
      'g1', 'acc_1', 'create', 'edge', edge.edgeId, null, expect.any(Object),
    )
  })
})

describe('listEdges', () => {
  it('drops soft-deleted edges and projects the public shape', async () => {
    vi.mocked(queryPrefix).mockResolvedValueOnce([
      {
        edgeId: 'edg_1', groupId: 'g1', edgeKind: 'partner', fromPerson: 'a',
        toPerson: 'b', subtype: 'married', PK: 'x', SK: 'y', deletedAt: null,
      },
      { edgeId: 'edg_2', deletedAt: '2026-01-01' },
    ])
    const edges = await listEdges('g1')
    expect(edges).toHaveLength(1)
    expect(edges[0]).not.toHaveProperty('PK')
  })
})

describe('updateEdge', () => {
  it('returns null when the edge is gone', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null)
    expect(await updateEdge('g1', 'acc_1', 'edg_x', { subtype: 'ex' })).toBeNull()
  })

  it('validates subtype against the stored kind and ignores endpoint changes', async () => {
    vi.mocked(getItem).mockResolvedValue({
      PK: 'GROUP#g1', SK: 'EDGE#edg_1', edgeId: 'edg_1', groupId: 'g1',
      edgeKind: 'partner', fromPerson: 'a', toPerson: 'b', subtype: 'married',
      deletedAt: null,
    })

    const edge = await updateEdge('g1', 'acc_1', 'edg_1', {
      subtype: 'ex',
      fromPerson: 'HACK', // immutable — ignored
    })
    expect(edge.subtype).toBe('ex')
    expect(edge.fromPerson).toBe('a')
    expect(edge.updatedBy).toBe('acc_1')

    await expect(
      updateEdge('g1', 'acc_1', 'edg_1', { subtype: 'adoptive' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('deleteEdge', () => {
  it('soft-deletes a live edge', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({
      PK: 'GROUP#g1', SK: 'EDGE#edg_1', edgeId: 'edg_1', edgeKind: 'partner',
      fromPerson: 'a', toPerson: 'b', deletedAt: null,
    })
    expect(await deleteEdge('g1', 'acc_1', 'edg_1')).toBe(true)
    expect(vi.mocked(putItem).mock.calls[0][0].deletedAt).toBeTruthy()
  })

  it('returns false when already gone', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null)
    expect(await deleteEdge('g1', 'acc_1', 'edg_1')).toBe(false)
  })
})
