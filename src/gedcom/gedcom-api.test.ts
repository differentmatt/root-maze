import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewImport, commitImport, exportGedcom } from '../api'
import { setCredential } from '../auth'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('gedcom api', () => {
  beforeEach(() => setCredential('test.jwt.token'))
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('posts the file to import/preview', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ stats: { people: 3 }, people: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await previewImport('grp_1', '0 HEAD\n0 TRLR')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/import/preview')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ gedcom: '0 HEAD\n0 TRLR' })
  })

  it('posts gedcom + resolutions to import/commit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ created: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    await commitImport('grp_1', '0 HEAD', {
      '@I1@': {
        action: 'merge',
        nodeId: 'nod_1',
        fields: ['birthdate'],
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/import/commit')
    const body = JSON.parse(init.body)
    expect(body.gedcom).toBe('0 HEAD')
    expect(body.resolutions['@I1@']).toEqual({
      action: 'merge',
      nodeId: 'nod_1',
      fields: ['birthdate'],
      updatedAt: '2024-01-01T00:00:00.000Z',
    })
  })

  it('fetches the export via GET', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ gedcom: '0 HEAD', filename: 'x.ged' }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await exportGedcom('grp_1')
    expect(res.gedcom).toBe('0 HEAD')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/groups/grp_1/export')
    expect(init.method).toBe('GET')
  })
})
