import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/dynamo.js', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
}))

import { getItem, putItem } from '../lib/dynamo.js'
import { resolveAccount } from '../lib/accounts.js'

describe('resolveAccount', () => {
  beforeEach(() => {
    vi.mocked(getItem).mockReset()
    vi.mocked(putItem).mockReset()
  })

  it('returns the existing account id for a known Google sub', async () => {
    vi.mocked(getItem).mockResolvedValueOnce({ accountId: 'acc_existing' })

    const result = await resolveAccount({ sub: 'g-123', email: 'a@b.com' })

    expect(result.accountId).toBe('acc_existing')
    expect(putItem).not.toHaveBeenCalled()
  })

  it('mints a new internal account id on first sign-in', async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null) // no existing auth link
    vi.mocked(putItem).mockResolvedValue(true) // link + account created

    const result = await resolveAccount({ sub: 'g-new', email: 'n@b.com' })

    expect(result.accountId).toMatch(/^acc_/)
    // Never store the Google sub as the id.
    expect(result.accountId).not.toContain('g-new')
    // Two writes: the provider link, then the account record.
    expect(putItem).toHaveBeenCalledTimes(2)
    const linkItem = vi.mocked(putItem).mock.calls[0][0]
    expect(linkItem.PK).toBe('AUTH#GOOGLE#g-new')
    expect(linkItem.accountId).toBe(result.accountId)
  })

  it('adopts the winner id if the create race is lost', async () => {
    vi.mocked(getItem)
      .mockResolvedValueOnce(null) // first check: no link
      .mockResolvedValueOnce({ accountId: 'acc_winner' }) // re-read after race
    vi.mocked(putItem).mockResolvedValueOnce(false) // conditional put failed

    const result = await resolveAccount({ sub: 'g-race', email: null })

    expect(result.accountId).toBe('acc_winner')
    // Only the link put was attempted; no orphan account record written.
    expect(putItem).toHaveBeenCalledTimes(1)
  })
})
