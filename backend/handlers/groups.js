import { authenticate } from '../lib/auth.js'
import { resolveAccount } from '../lib/accounts.js'
import { createGroup, renameGroup } from '../lib/groups.js'
import { requireGroupMember } from '../lib/http.js'
import { ValidationError } from '../lib/errors.js'
import { ok, badRequest, notFound, unauthorized, serverError } from '../lib/response.js'

// Group create + rename.
//   POST  /api/groups               -> create a group (caller becomes owner)
//   PATCH /api/groups/{groupId}     -> rename a group (any member may rename)
export async function handler(event) {
  try {
    const method = event.requestContext.http.method

    if (method === 'POST') return await create(event)
    if (method === 'PATCH') return await rename(event)

    return badRequest('Unsupported method')
  } catch (err) {
    if (err instanceof ValidationError) return badRequest(err.message)
    console.error(err)
    return serverError('Internal server error')
  }
}

async function create(event) {
  const user = await authenticate(event)
  if (!user) return unauthorized()

  const body = JSON.parse(event.body || '{}')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('Missing group name')
  if (name.length > 100) return badRequest('Group name too long')

  const account = await resolveAccount(user)
  const group = await createGroup(account.accountId, name)

  return ok(group)
}

async function rename(event) {
  const groupId = event.pathParameters?.groupId
  if (!groupId) return badRequest('Missing group id')

  const { response, account } = await requireGroupMember(event, groupId)
  if (response) return response

  const body = JSON.parse(event.body || '{}')
  const result = await renameGroup(groupId, account.accountId, body.name)
  if (result === 'not_found') return notFound('Group not found')

  return ok({ groupId: result.groupId, name: result.name })
}
