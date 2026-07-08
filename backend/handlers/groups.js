import { authenticate } from '../lib/auth.js'
import { resolveAccount } from '../lib/accounts.js'
import { createGroup } from '../lib/groups.js'
import { ok, badRequest, unauthorized, serverError } from '../lib/response.js'

// POST /api/groups — create a group; the caller becomes its owner.
export async function handler(event) {
  try {
    const user = await authenticate(event)
    if (!user) return unauthorized()

    const method = event.requestContext.http.method
    if (method !== 'POST') return badRequest('Unsupported method')

    const body = JSON.parse(event.body || '{}')
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return badRequest('Missing group name')
    if (name.length > 100) return badRequest('Group name too long')

    const account = await resolveAccount(user)
    const group = await createGroup(account.accountId, name)

    return ok(group)
  } catch (err) {
    console.error(err)
    return serverError('Internal server error')
  }
}
