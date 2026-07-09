import { requireGroupMember } from '../lib/http.js'
import { createNode, updateNode, deleteNode } from '../lib/nodes.js'
import { ValidationError } from '../lib/errors.js'
import {
  ok,
  badRequest,
  notFound,
  serverError,
} from '../lib/response.js'

// person_node writes:
//   POST   /api/groups/{groupId}/nodes            -> create
//   PATCH  /api/groups/{groupId}/nodes/{nodeId}   -> update
//   DELETE /api/groups/{groupId}/nodes/{nodeId}   -> soft-delete (cascades edges)
// Reads go through GET /api/groups/{groupId}/graph.
export async function handler(event) {
  try {
    const groupId = event.pathParameters?.groupId
    if (!groupId) return badRequest('Missing group id')

    const { response, account } = await requireGroupMember(event, groupId)
    if (response) return response

    const method = event.requestContext.http.method
    const nodeId = event.pathParameters?.nodeId
    const body = parseBody(event.body)

    if (method === 'POST') {
      const node = await createNode(groupId, account.accountId, body)
      return ok(node)
    }

    if (method === 'PATCH') {
      if (!nodeId) return badRequest('Missing node id')
      const node = await updateNode(groupId, account.accountId, nodeId, body)
      return node ? ok(node) : notFound('Person not found')
    }

    if (method === 'DELETE') {
      if (!nodeId) return badRequest('Missing node id')
      const removed = await deleteNode(groupId, account.accountId, nodeId)
      return removed ? ok({ deleted: true }) : notFound('Person not found')
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
