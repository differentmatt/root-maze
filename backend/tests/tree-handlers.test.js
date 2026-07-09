import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/http.js', () => ({ requireGroupMember: vi.fn() }))
vi.mock('../lib/graph.js', () => ({ getGraph: vi.fn() }))
vi.mock('../lib/nodes.js', () => ({
  createNode: vi.fn(),
  updateNode: vi.fn(),
  deleteNode: vi.fn(),
}))
vi.mock('../lib/edges.js', () => ({
  createEdge: vi.fn(),
  updateEdge: vi.fn(),
  deleteEdge: vi.fn(),
}))

import { requireGroupMember } from '../lib/http.js'
import { getGraph } from '../lib/graph.js'
import { createNode, updateNode, deleteNode } from '../lib/nodes.js'
import { createEdge, updateEdge, deleteEdge } from '../lib/edges.js'
import { ValidationError } from '../lib/errors.js'
import { handler as graphHandler } from '../handlers/graph.js'
import { handler as nodesHandler } from '../handlers/nodes.js'
import { handler as edgesHandler } from '../handlers/edges.js'

const member = () => ({ account: { accountId: 'acc_1' } })

function evt({ method = 'GET', groupId = 'g1', path = {}, body } = {}) {
  return {
    pathParameters: { groupId, ...path },
    requestContext: { http: { method } },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireGroupMember).mockResolvedValue(member())
})

describe('membership gate', () => {
  it('propagates the 403/401 from requireGroupMember', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce({
      response: { statusCode: 403, body: '{}' },
    })
    const res = await graphHandler(evt())
    expect(res.statusCode).toBe(403)
    expect(getGraph).not.toHaveBeenCalled()
  })

  it('400s when the group id is missing', async () => {
    const res = await nodesHandler(evt({ method: 'POST', groupId: '' }))
    expect(res.statusCode).toBe(400)
  })
})

describe('GET graph', () => {
  it('returns the graph for a member', async () => {
    vi.mocked(getGraph).mockResolvedValueOnce({ nodes: [], edges: [] })
    const res = await graphHandler(evt())
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ nodes: [], edges: [] })
    expect(getGraph).toHaveBeenCalledWith('g1')
  })
})

describe('nodes handler', () => {
  it('creates on POST', async () => {
    vi.mocked(createNode).mockResolvedValueOnce({ nodeId: 'nod_1', name: 'Ada' })
    const res = await nodesHandler(evt({ method: 'POST', body: { name: 'Ada' } }))
    expect(res.statusCode).toBe(200)
    expect(createNode).toHaveBeenCalledWith('g1', 'acc_1', { name: 'Ada' })
  })

  it('maps a ValidationError to 400', async () => {
    vi.mocked(createNode).mockRejectedValueOnce(new ValidationError('Missing person name'))
    const res = await nodesHandler(evt({ method: 'POST', body: {} }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/Missing person name/)
  })

  it('404s a PATCH on a missing node', async () => {
    vi.mocked(updateNode).mockResolvedValueOnce(null)
    const res = await nodesHandler(
      evt({ method: 'PATCH', path: { nodeId: 'nod_x' }, body: { name: 'X' } }),
    )
    expect(res.statusCode).toBe(404)
  })

  it('DELETE reports success', async () => {
    vi.mocked(deleteNode).mockResolvedValueOnce(true)
    const res = await nodesHandler(evt({ method: 'DELETE', path: { nodeId: 'nod_1' } }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ deleted: true })
  })
})

describe('edges handler', () => {
  it('creates on POST', async () => {
    vi.mocked(createEdge).mockResolvedValueOnce({ edgeId: 'edg_1' })
    const res = await edgesHandler(
      evt({ method: 'POST', body: { edgeKind: 'partner', fromPerson: 'a', toPerson: 'b' } }),
    )
    expect(res.statusCode).toBe(200)
    expect(createEdge).toHaveBeenCalledWith('g1', 'acc_1', {
      edgeKind: 'partner', fromPerson: 'a', toPerson: 'b',
    })
  })

  it('maps a ValidationError to 400', async () => {
    vi.mocked(createEdge).mockRejectedValueOnce(new ValidationError('bad'))
    const res = await edgesHandler(evt({ method: 'POST', body: {} }))
    expect(res.statusCode).toBe(400)
  })

  it('updates on PATCH', async () => {
    vi.mocked(updateEdge).mockResolvedValueOnce({ edgeId: 'edg_1', subtype: 'ex' })
    const res = await edgesHandler(
      evt({ method: 'PATCH', path: { edgeId: 'edg_1' }, body: { subtype: 'ex' } }),
    )
    expect(res.statusCode).toBe(200)
  })

  it('404s a DELETE on a missing edge', async () => {
    vi.mocked(deleteEdge).mockResolvedValueOnce(false)
    const res = await edgesHandler(evt({ method: 'DELETE', path: { edgeId: 'edg_x' } }))
    expect(res.statusCode).toBe(404)
  })
})
