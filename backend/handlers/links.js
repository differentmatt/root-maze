import { requireGroupMember } from '../lib/http.js'
import { linkAccountToNode, unlinkAccount } from '../lib/links.js'
import {
  ok,
  badRequest,
  forbidden,
  notFound,
  conflict,
  serverError,
} from '../lib/response.js'

// Identity linking: connect a member's account to a person_node in the tree.
//   PUT    /api/groups/{groupId}/members/{accountId}/link   body { nodeId }
//   DELETE /api/groups/{groupId}/members/{accountId}/link
//
// Permissions: a member may link/unlink their OWN account freely ("this is me"),
// but linking or unlinking ANOTHER member's account is owner-only. Claiming an
// identity is personal and low-friction; reassigning who someone else is, is an
// admin act, so it stays with the trusted owner tier (a group always keeps ≥1).
export async function handler(event) {
  try {
    const groupId = event.pathParameters?.groupId
    const targetId = event.pathParameters?.accountId
    if (!groupId || !targetId) return badRequest('Missing group or account id')

    const { response, account, member } = await requireGroupMember(event, groupId)
    if (response) return response

    // Self is always allowed; touching another member's link requires owner.
    if (targetId !== account.accountId && member.role !== 'owner') {
      return forbidden()
    }

    const method = event.requestContext.http.method

    if (method === 'PUT') {
      const body = parseBody(event.body)
      if (!body.nodeId) return badRequest('Missing nodeId')
      const result = await linkAccountToNode(
        groupId,
        account.accountId,
        targetId,
        body.nodeId,
      )
      if (result === 'not_found_member') return notFound('Member not found')
      if (result === 'not_found_node') return notFound('Person not found')
      if (result === 'conflict') {
        return conflict('That person is already linked to another member')
      }
      return ok({ accountId: targetId, nodeId: result.nodeId })
    }

    if (method === 'DELETE') {
      const result = await unlinkAccount(groupId, account.accountId, targetId)
      if (result === 'not_found') return notFound('No linked person to unlink')
      return ok({ accountId: targetId, nodeId: result.nodeId, unlinked: true })
    }

    return badRequest('Unsupported method')
  } catch (err) {
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
