import { authenticate } from './auth.js'
import { resolveAccount } from './accounts.js'
import { requireMember, ForbiddenError } from './groups.js'
import { unauthorized, forbidden } from './response.js'

// Shared gate for every group-scoped handler: verify the Google token, resolve
// the internal account, and assert active membership of the target group.
//
// Returns either { account, member } on success or { response } holding a
// ready-to-return 401/403. `member` is the caller's membership row, so handlers
// that care about the caller's role (e.g. identity linking) can read it without
// a second lookup. Keeping the branch in the caller (rather than throwing) makes
// the happy path in each handler a single early-return check.
export async function requireGroupMember(event, groupId) {
  const user = await authenticate(event)
  if (!user) return { response: unauthorized() }

  const account = await resolveAccount(user)
  try {
    const member = await requireMember(groupId, account.accountId)
    return { account, member }
  } catch (err) {
    if (err instanceof ForbiddenError) return { response: forbidden() }
    throw err
  }
}
