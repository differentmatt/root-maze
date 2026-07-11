import { requireGroupMember } from '../lib/http.js'
import { previewImport, commitImport } from '../lib/gedcom-import.js'
import { graphToGedcom } from '../lib/gedcom.js'
import { getGraph } from '../lib/graph.js'
import { ValidationError } from '../lib/errors.js'
import { ok, badRequest, serverError } from '../lib/response.js'

// GEDCOM import/export. One Lambda backs three routes, told apart by method and
// path suffix (all gated by requireGroupMember — any member may import/export,
// matching the app's low-friction stance):
//
//   POST /api/groups/{groupId}/import/preview  -> diff a file against the tree
//   POST /api/groups/{groupId}/import/commit   -> apply create/merge/skip + edges
//   GET  /api/groups/{groupId}/export          -> whole group as GEDCOM 5.5.1
//
// A "new group from a file" is just: create the group (existing route), then
// commit an import into it — no special path needed, since an empty group
// yields no matches and every person imports as new.

// Guard against a pathological upload before we parse it. Family GEDCOMs are
// comfortably under a megabyte; this is a safety cap, not a real limit.
const MAX_GEDCOM_CHARS = 8_000_000

export async function handler(event) {
  try {
    const groupId = event.pathParameters?.groupId
    if (!groupId) return badRequest('Missing group id')

    const { response, account } = await requireGroupMember(event, groupId)
    if (response) return response

    const method = event.requestContext.http.method
    const path = event.requestContext.http.path || event.rawPath || ''

    // Await inside the try so an async ValidationError is caught here and
    // mapped to a 400, rather than escaping as an unhandled rejection.
    if (method === 'GET' && path.endsWith('/export')) {
      return await exportGedcom(groupId)
    }
    if (method === 'POST' && path.endsWith('/import/preview')) {
      return await importPreview(groupId, event)
    }
    if (method === 'POST' && path.endsWith('/import/commit')) {
      return await importCommit(groupId, account.accountId, event)
    }
    return badRequest('Unsupported method')
  } catch (err) {
    if (err instanceof ValidationError) return badRequest(err.message)
    console.error(err)
    return serverError('Internal server error')
  }
}

async function exportGedcom(groupId) {
  const graph = await getGraph(groupId)
  const gedcom = graphToGedcom(graph)
  // Returned as JSON (not a raw download) so the same-origin fetch wrapper and
  // its Bearer auth stay uniform; the client turns it into a .ged file. A
  // filename is suggested from the group's node count for a friendly default.
  return ok({ gedcom, filename: 'root-maze.ged' })
}

async function importPreview(groupId, event) {
  const gedcom = readGedcom(event)
  const preview = await previewImport(groupId, gedcom)
  return ok(preview)
}

async function importCommit(groupId, accountId, event) {
  const body = parseBody(event.body)
  const gedcom = readGedcomFrom(body)
  const resolutions =
    body.resolutions && typeof body.resolutions === 'object' ? body.resolutions : {}
  const summary = await commitImport(groupId, accountId, gedcom, resolutions)
  return ok(summary)
}

function readGedcom(event) {
  return readGedcomFrom(parseBody(event.body))
}

function readGedcomFrom(body) {
  const gedcom = body?.gedcom
  if (typeof gedcom !== 'string' || !gedcom.trim()) {
    throw new ValidationError('Missing GEDCOM content')
  }
  if (gedcom.length > MAX_GEDCOM_CHARS) {
    throw new ValidationError('GEDCOM file is too large')
  }
  return gedcom
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}
