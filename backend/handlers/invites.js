import { authenticate } from '../lib/auth.js'
import { resolveAccount } from '../lib/accounts.js'
import { requireGroupMember } from '../lib/http.js'
import {
  createInvite,
  listInvites,
  revokeInvite,
  previewInvite,
  acceptInvite,
} from '../lib/invites.js'
import { ValidationError } from '../lib/errors.js'
import {
  ok,
  badRequest,
  unauthorized,
  notFound,
  gone,
  serverError,
} from '../lib/response.js'

// This one Lambda backs two families of routes, told apart by their path
// parameters:
//
// Group-scoped management (any member; gated by requireGroupMember):
//   GET    /api/groups/{groupId}/invites            -> list active invites
//   POST   /api/groups/{groupId}/invites            -> create an invite
//   DELETE /api/groups/{groupId}/invites/{token}    -> revoke an invite
//
// Token-addressed (the shared link only carries a token, not a groupId):
//   GET    /api/invites/{token}                     -> public preview (no auth)
//   POST   /api/invites/{token}/accept              -> join (auth, any account)
export async function handler(event) {
  try {
    const groupId = event.pathParameters?.groupId
    if (groupId) return handleManagement(event, groupId)
    return handleToken(event)
  } catch (err) {
    if (err instanceof ValidationError) return badRequest(err.message)
    console.error(err)
    return serverError('Internal server error')
  }
}

async function handleManagement(event, groupId) {
  const { response, account } = await requireGroupMember(event, groupId)
  if (response) return response

  const method = event.requestContext.http.method
  const token = event.pathParameters?.token

  if (method === 'GET') {
    const invites = await listInvites(groupId)
    return ok({ invites })
  }

  if (method === 'POST') {
    const body = parseBody(event.body)
    const invite = await createInvite(groupId, account.accountId, body)
    return ok(invite)
  }

  if (method === 'DELETE') {
    if (!token) return badRequest('Missing invite token')
    const revoked = await revokeInvite(groupId, account.accountId, token)
    return revoked ? ok({ revoked: true }) : notFound('Invite not found')
  }

  return badRequest('Unsupported method')
}

async function handleToken(event) {
  const token = event.pathParameters?.token
  if (!token) return badRequest('Missing invite token')

  const method = event.requestContext.http.method

  // Public preview — no authentication, minimal disclosure.
  if (method === 'GET') {
    const preview = await previewInvite(token)
    return ok(preview)
  }

  // Accept — the caller must be signed in, but need not already be a member.
  if (method === 'POST') {
    const user = await authenticate(event)
    if (!user) return unauthorized()

    const account = await resolveAccount(user)
    const result = await acceptInvite(account.accountId, token)
    if (!result.ok) return gone('This invite is no longer valid')
    return ok({ groupId: result.groupId, name: result.name, role: result.role })
  }

  return badRequest('Unsupported method')
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}
