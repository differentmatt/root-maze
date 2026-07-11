import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/http.js', () => ({ requireGroupMember: vi.fn() }))
vi.mock('../lib/gedcom-import.js', () => ({
  previewImport: vi.fn(),
  commitImport: vi.fn(),
}))
vi.mock('../lib/graph.js', () => ({ getGraph: vi.fn() }))

import { requireGroupMember } from '../lib/http.js'
import { previewImport, commitImport } from '../lib/gedcom-import.js'
import { getGraph } from '../lib/graph.js'
import { handler } from '../handlers/gedcom.js'

function evt({ method = 'POST', suffix = '/import/preview', groupId = 'g1', body } = {}) {
  return {
    pathParameters: { groupId },
    requestContext: { http: { method, path: `/api/groups/${groupId}${suffix}` } },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireGroupMember).mockResolvedValue({ account: { accountId: 'acc_1' } })
})

describe('membership gate', () => {
  it('propagates a 403 and touches nothing', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce({
      response: { statusCode: 403, body: '{}' },
    })
    const res = await handler(evt())
    expect(res.statusCode).toBe(403)
    expect(previewImport).not.toHaveBeenCalled()
  })

  it('400s a missing group id', async () => {
    const res = await handler(evt({ groupId: '' }))
    expect(res.statusCode).toBe(400)
  })
})

describe('import preview', () => {
  it('parses the body and returns the preview', async () => {
    vi.mocked(previewImport).mockResolvedValueOnce({ stats: { people: 1 } })
    const res = await handler(evt({ body: { gedcom: '0 HEAD\n0 TRLR' } }))
    expect(res.statusCode).toBe(200)
    expect(previewImport).toHaveBeenCalledWith('g1', '0 HEAD\n0 TRLR')
  })

  it('400s when the GEDCOM content is missing', async () => {
    const res = await handler(evt({ body: {} }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/Missing GEDCOM/)
  })
})

describe('import commit', () => {
  it('passes gedcom + resolutions through and returns the summary', async () => {
    vi.mocked(commitImport).mockResolvedValueOnce({ created: 2 })
    const res = await handler(
      evt({
        suffix: '/import/commit',
        body: { gedcom: '0 HEAD', resolutions: { '@I1@': { action: 'skip' } } },
      }),
    )
    expect(res.statusCode).toBe(200)
    expect(commitImport).toHaveBeenCalledWith('g1', 'acc_1', '0 HEAD', {
      '@I1@': { action: 'skip' },
    })
    expect(JSON.parse(res.body)).toEqual({ created: 2 })
  })
})

describe('export', () => {
  it('serializes the graph to GEDCOM and returns a filename', async () => {
    vi.mocked(getGraph).mockResolvedValueOnce({ nodes: [], edges: [] })
    const res = await handler(evt({ method: 'GET', suffix: '/export' }))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.gedcom).toContain('0 HEAD')
    expect(body.gedcom).toContain('0 TRLR')
    expect(body.filename).toMatch(/\.ged$/)
  })
})
