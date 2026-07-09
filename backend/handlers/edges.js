import { requireGroupMember } from '../lib/http.js'
import { createEdge, updateEdge, deleteEdge } from '../lib/edges.js'
import { ValidationError } from '../lib/errors.js'
import {
  ok,
  badRequest,
  notFound,
  serverError,
} from '../lib/response.js'

// edge writes:
//   POST   /api/groups/{groupId}/edges            -> create (parent_child|partner)
//   PATCH  /api/groups/{groupId}/edges/{edgeId}   -> update subtype/dates
//   DELETE /api/groups/{groupId}/edges/{edgeId}   -> soft-delete
// Reads go through GET /api/groups/{groupId}/graph.
export async function handler(event) {
  try {
    const groupId = event.pathParameters?.groupId
    if (!groupId) return badRequest('Missing group id')

    const { response, account } = await requireGroupMember(event, groupId)
    if (response) return response

    const method = event.requestContext.http.method
    const edgeId = event.pathParameters?.edgeId
    const body = parseBody(event.body)

    if (method === 'POST') {
      const edge = await createEdge(groupId, account.accountId, body)
      return ok(edge)
    }

    if (method === 'PATCH') {
      if (!edgeId) return badRequest('Missing edge id')
      const edge = await updateEdge(groupId, account.accountId, edgeId, body)
      return edge ? ok(edge) : notFound('Relationship not found')
    }

    if (method === 'DELETE') {
      if (!edgeId) return badRequest('Missing edge id')
      const removed = await deleteEdge(groupId, account.accountId, edgeId)
      return removed ? ok({ deleted: true }) : notFound('Relationship not found')
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
