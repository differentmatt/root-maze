import { requireGroupMember } from '../lib/http.js'
import { getGraph } from '../lib/graph.js'
import { ok, badRequest, serverError } from '../lib/response.js'

// GET /api/groups/{groupId}/graph — the group's people + relationships.
// Group isolation is enforced by requireGroupMember before any data is read.
export async function handler(event) {
  try {
    const groupId = event.pathParameters?.groupId
    if (!groupId) return badRequest('Missing group id')

    const { response } = await requireGroupMember(event, groupId)
    if (response) return response

    if (event.requestContext.http.method !== 'GET') {
      return badRequest('Unsupported method')
    }

    return ok(await getGraph(groupId))
  } catch (err) {
    console.error(err)
    return serverError('Internal server error')
  }
}
