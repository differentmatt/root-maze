import { authenticate } from './auth.js'
import { resolveAccount } from './accounts.js'
import { requireMember, ForbiddenError } from './groups.js'
import { unauthorized, forbidden } from './response.js'

// Shared gate for every group-scoped handler: verify the Google token, resolve
// the internal account, and assert active membership of the target group.
//
// Returns either { account } on success or { response } holding a ready-to-
// return 401/403. Keeping the branch in the caller (rather than throwing) makes
// the happy path in each handler a single early-return check.
export async function requireGroupMember(event, groupId) {
  const user = await authenticate(event)
  if (!user) return { response: unauthorized() }

  const account = await resolveAccount(user)
  try {
    await requireMember(groupId, account.accountId)
  } catch (err) {
    if (err instanceof ForbiddenError) return { response: forbidden() }
    throw err
  }
  return { account }
}
