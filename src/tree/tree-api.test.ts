import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getGraph,
  createNode,
  updateNode,
  deleteNode,
  createEdge,
  deleteEdge,
} from '../api'
import { setCredential } from '../auth'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('tree api', () => {
  beforeEach(() => setCredential('test.jwt.token'))
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('fetches the group graph with the bearer token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ nodes: [], edges: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const graph = await getGraph('grp_1')
    expect(graph).toEqual({ nodes: [], edges: [] })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/graph')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer test.jwt.token')
  })

  it('creates a person via POST /nodes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ nodeId: 'nod_1', name: 'Ada' }))
    vi.stubGlobal('fetch', fetchMock)

    await createNode('grp_1', { firstName: 'Ada', birthdate: '1815' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/nodes')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ firstName: 'Ada', birthdate: '1815' })
  })

  it('patches a person via PATCH /nodes/:id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ nodeId: 'nod_1', name: 'Ada L.' }))
    vi.stubGlobal('fetch', fetchMock)

    await updateNode('grp_1', 'nod_1', { lastName: 'Lovelace' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/nodes/nod_1')
    expect(init.method).toBe('PATCH')
  })

  it('deletes a person via DELETE /nodes/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ deleted: true }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await deleteNode('grp_1', 'nod_1')
    expect(res).toEqual({ deleted: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/nodes/nod_1')
    expect(init.method).toBe('DELETE')
  })

  it('creates an edge via POST /edges', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ edgeId: 'edg_1' }))
    vi.stubGlobal('fetch', fetchMock)

    await createEdge('grp_1', {
      edgeKind: 'partner',
      fromPerson: 'nod_1',
      toPerson: 'nod_2',
      subtype: 'married',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/edges')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body).edgeKind).toBe('partner')
  })

  it('deletes an edge via DELETE /edges/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ deleted: true }))
    vi.stubGlobal('fetch', fetchMock)

    await deleteEdge('grp_1', 'edg_1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/edges/edg_1')
    expect(init.method).toBe('DELETE')
  })
})
