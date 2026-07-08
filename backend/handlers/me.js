import { authenticate } from '../lib/auth.js'
import { resolveAccount } from '../lib/accounts.js'
import { listGroupsForAccount } from '../lib/groups.js'
import { ok, unauthorized, serverError } from '../lib/response.js'

// GET /api/me — the Phase 0 loop.
// Verifies the Google token, resolves (or creates) the internal account, and
// returns the groups the caller belongs to.
export async function handler(event) {
  try {
    const user = await authenticate(event)
    if (!user) return unauthorized()

    const account = await resolveAccount(user)
    const groups = await listGroupsForAccount(account.accountId)

    return ok({
      accountId: account.accountId,
      email: account.email,
      groups,
    })
  } catch (err) {
    console.error(err)
    return serverError('Internal server error')
  }
}
