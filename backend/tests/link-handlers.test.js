import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/http.js', () => ({ requireGroupMember: vi.fn() }))
vi.mock('../lib/links.js', () => ({
  linkAccountToNode: vi.fn(),
  unlinkAccount: vi.fn(),
}))

import { requireGroupMember } from '../lib/http.js'
import { linkAccountToNode, unlinkAccount } from '../lib/links.js'
import { handler as linksHandler } from '../handlers/links.js'

beforeEach(() => {
  vi.clearAllMocks()
})

function event({ method, path = {}, body } = {}) {
  return {
    pathParameters: path,
    requestContext: { http: { method } },
    body: body ? JSON.stringify(body) : undefined,
  }
}

// Caller acc_1 is the group owner unless a test overrides it.
function asCaller(accountId = 'acc_1', role = 'owner') {
  vi.mocked(requireGroupMember).mockResolvedValueOnce({
    account: { accountId },
    member: { accountId, role },
  })
}

describe('links handler — auth & routing', () => {
  it('403s when not a group member', async () => {
    vi.mocked(requireGroupMember).mockResolvedValueOnce({
      response: { statusCode: 403, body: '{}' },
    })
    const res = await linksHandler(
      event({ method: 'PUT', path: { groupId: 'g1', accountId: 'acc_1' }, body: { nodeId: 'nod_1' } }),
    )
    expect(res.statusCode).toBe(403)
  })

  it('lets an editor link their OWN account', async () => {
    asCaller('acc_1', 'editor')
    vi.mocked(linkAccountToNode).mockResolvedValueOnce({ status: 'ok', nodeId: 'nod_1' })
    const res = await linksHandler(
      event({ method: 'PUT', path: { groupId: 'g1', accountId: 'acc_1' }, body: { nodeId: 'nod_1' } }),
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ accountId: 'acc_1', nodeId: 'nod_1' })
    expect(linkAccountToNode).toHaveBeenCalledWith('g1', 'acc_1', 'acc_1', 'nod_1')
  })

  it('forbids an editor linking ANOTHER member', async () => {
    asCaller('acc_1', 'editor')
    const res = await linksHandler(
      event({ method: 'PUT', path: { groupId: 'g1', accountId: 'acc_2' }, body: { nodeId: 'nod_1' } }),
    )
    expect(res.statusCode).toBe(403)
    expect(linkAccountToNode).not.toHaveBeenCalled()
  })

  it('lets an owner link another member', async () => {
    asCaller('acc_1', 'owner')
    vi.mocked(linkAccountToNode).mockResolvedValueOnce({ status: 'ok', nodeId: 'nod_1' })
    const res = await linksHandler(
      event({ method: 'PUT', path: { groupId: 'g1', accountId: 'acc_2' }, body: { nodeId: 'nod_1' } }),
    )
    expect(res.statusCode).toBe(200)
    expect(linkAccountToNode).toHaveBeenCalledWith('g1', 'acc_1', 'acc_2', 'nod_1')
  })
})

describe('links handler — link outcomes', () => {
  it('400s a missing nodeId', async () => {
    asCaller()
    const res = await linksHandler(
      event({ method: 'PUT', path: { groupId: 'g1', accountId: 'acc_1' }, body: {} }),
    )
    expect(res.statusCode).toBe(400)
  })

  it('404s a missing person', async () => {
    asCaller()
    vi.mocked(linkAccountToNode).mockResolvedValueOnce('not_found_node')
    const res = await linksHandler(
      event({ method: 'PUT', path: { groupId: 'g1', accountId: 'acc_1' }, body: { nodeId: 'nod_x' } }),
    )
    expect(res.statusCode).toBe(404)
  })

  it('409s a node already claimed by someone else', async () => {
    asCaller()
    vi.mocked(linkAccountToNode).mockResolvedValueOnce('conflict')
    const res = await linksHandler(
      event({ method: 'PUT', path: { groupId: 'g1', accountId: 'acc_1' }, body: { nodeId: 'nod_1' } }),
    )
    expect(res.statusCode).toBe(409)
  })
})

describe('links handler — unlink', () => {
  it('unlinks the caller and reports the freed node', async () => {
    asCaller('acc_1', 'editor')
    vi.mocked(unlinkAccount).mockResolvedValueOnce({ status: 'ok', nodeId: 'nod_1' })
    const res = await linksHandler(
      event({ method: 'DELETE', path: { groupId: 'g1', accountId: 'acc_1' } }),
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ accountId: 'acc_1', nodeId: 'nod_1', unlinked: true })
  })

  it('404s when there is nothing linked', async () => {
    asCaller()
    vi.mocked(unlinkAccount).mockResolvedValueOnce('not_found')
    const res = await linksHandler(
      event({ method: 'DELETE', path: { groupId: 'g1', accountId: 'acc_1' } }),
    )
    expect(res.statusCode).toBe(404)
  })

  it('forbids an editor unlinking another member', async () => {
    asCaller('acc_1', 'editor')
    const res = await linksHandler(
      event({ method: 'DELETE', path: { groupId: 'g1', accountId: 'acc_2' } }),
    )
    expect(res.statusCode).toBe(403)
    expect(unlinkAccount).not.toHaveBeenCalled()
  })
})
