import { requireGroupMember } from '../lib/http.js'
import { listMembers, removeMember, changeMemberRole } from '../lib/groups.js'
import { ValidationError } from '../lib/errors.js'
import { ok, badRequest, notFound, conflict, serverError } from '../lib/response.js'

// Membership management. Every member of the group may manage membership (the
// app is a casual shared family tree), but the group always keeps at least one
// owner — the last owner can't be removed or demoted.
//   GET    /api/groups/{groupId}/members               -> list
//   DELETE /api/groups/{groupId}/members/{accountId}   -> remove (soft-delete)
//   PATCH  /api/groups/{groupId}/members/{accountId}   -> change role
export async function handler(event) {
  try {
    const groupId = event.pathParameters?.groupId
    if (!groupId) return badRequest('Missing group id')

    const { response, account } = await requireGroupMember(event, groupId)
    if (response) return response

    const method = event.requestContext.http.method
    const targetId = event.pathParameters?.accountId

    if (method === 'GET') {
      const members = await listMembers(groupId)
      return ok({ members, me: account.accountId })
    }

    if (method === 'DELETE') {
      if (!targetId) return badRequest('Missing account id')
      const result = await removeMember(groupId, account.accountId, targetId)
      if (result === 'not_found') return notFound('Member not found')
      if (result === 'last_owner') return conflict('Cannot remove the last owner')
      return ok({ removed: true })
    }

    if (method === 'PATCH') {
      if (!targetId) return badRequest('Missing account id')
      const body = parseBody(event.body)
      const result = await changeMemberRole(groupId, account.accountId, targetId, body.role)
      if (result === 'not_found') return notFound('Member not found')
      if (result === 'last_owner') return conflict('Cannot demote the last owner')
      return ok({ accountId: targetId, role: result.role })
    }

    return badRequest('Unsupported method')
  } catch (err) {
    if (err instanceof ValidationError) return badRequest(err.message)
    console.error(err)
    return serverError('Internal server error')
  }
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}
