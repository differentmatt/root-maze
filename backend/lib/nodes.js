import { getItem, putItem, queryPrefix } from './dynamo.js'
import { newNodeId } from './ids.js'
import { appendLog } from './groups.js'
import { ValidationError } from './errors.js'

// person_node rows live under the group partition (GROUP#<groupId>) with a
// NODE#<nodeId> sort key, so a single partition query returns the whole graph's
// people. Every row carries updatedAt/updatedBy and a soft-delete deletedAt;
// accountId is nullable so a person can exist in the tree before (or without)
// ever signing in.
//
// Names are structured: firstName (required) plus optional lastName, middleName,
// and birthName (name at birth / former name). Legacy rows predate this and
// carry only a single `name` string; nodeFullName below tolerates both, so no
// data migration is needed — a legacy person keeps rendering, and picks up the
// structured fields the next time someone edits them.

function nodeKey(groupId, nodeId) {
  return { PK: `GROUP#${groupId}`, SK: `NODE#${nodeId}` }
}

/**
 * Trim a client-supplied optional string down to a value or null.
 * Non-string values return null immediately. Blank/whitespace strings also
 * collapse to null so we never store "" for an absent name part.
 * @param {unknown} v
 * @returns {string | null}
 */
function cleanOpt(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t || null
}

// Canonical full name derived from the structured parts, e.g. "Ada Byron King".
// Falls back to a legacy row's single `name` string when no parts are present,
// so both old and new rows resolve to something displayable.
export function nodeFullName(item) {
  const parts = [item.firstName, item.middleName, item.lastName]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
  if (parts.length) return parts.join(' ')
  return typeof item.name === 'string' ? item.name : ''
}

// Project a stored row down to the public shape the API returns — no PK/SK or
// soft-delete bookkeeping leaks to the client. `name` is always the derived full
// name so existing clients keep working; the parts let a richer UI render
// "First L." and "born …" without re-parsing.
function toNode(item) {
  return {
    nodeId: item.nodeId,
    groupId: item.groupId,
    name: nodeFullName(item),
    firstName: item.firstName ?? null,
    lastName: item.lastName ?? null,
    middleName: item.middleName ?? null,
    birthName: item.birthName ?? null,
    birthdate: item.birthdate ?? null,
    deathdate: item.deathdate ?? null,
    notes: item.notes ?? null,
    accountId: item.accountId ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
  }
}

// Optional fields a client may set on create or patch. firstName is handled
// separately because it's required and validated. Anything else in the body is
// ignored — clients can't write PK/SK, timestamps, or deletedAt. accountId is
// deliberately NOT writable here: identity linking has its own integrity-checked
// endpoint (see lib/links.js), so a plain node write can't bypass the
// one-account-per-node / one-node-per-account rules.
const OPTIONAL_NAME_PARTS = ['lastName', 'middleName', 'birthName']
const PLAIN_WRITABLE = ['birthdate', 'deathdate', 'notes']

function applyWritable(target, input) {
  if (input.firstName !== undefined) target.firstName = input.firstName.trim()
  for (const field of OPTIONAL_NAME_PARTS) {
    if (input[field] !== undefined) target[field] = cleanOpt(input[field])
  }
  for (const field of PLAIN_WRITABLE) {
    if (input[field] !== undefined) target[field] = input[field]
  }
}

export async function listNodes(groupId) {
  const items = await queryPrefix(`GROUP#${groupId}`, 'NODE#')
  return items.filter((i) => !i.deletedAt).map(toNode)
}

// Fetch a single live node, or null if it's missing or soft-deleted.
export async function getNode(groupId, nodeId) {
  const item = await getItem(nodeKey(groupId, nodeId))
  if (!item || item.deletedAt) return null
  return toNode(item)
}

export async function createNode(groupId, accountId, input) {
  const firstName = typeof input.firstName === 'string' ? input.firstName.trim() : ''
  if (!firstName) throw new ValidationError('Missing first name')

  const nodeId = newNodeId()
  const now = new Date().toISOString()

  const item = {
    ...nodeKey(groupId, nodeId),
    nodeId,
    groupId,
    firstName,
    lastName: cleanOpt(input.lastName),
    middleName: cleanOpt(input.middleName),
    birthName: cleanOpt(input.birthName),
    birthdate: input.birthdate ?? null,
    deathdate: input.deathdate ?? null,
    notes: input.notes ?? null,
    // Nodes are always created unlinked; linking goes through lib/links.js.
    accountId: null,
    createdAt: now,
    updatedAt: now,
    updatedBy: accountId,
    deletedAt: null,
  }

  await putItem(item)
  await appendLog(groupId, accountId, 'create', 'node', nodeId, null, toNode(item))
  return toNode(item)
}

// Patch a node in place. Returns the updated node, or null if it doesn't exist.
export async function updateNode(groupId, accountId, nodeId, patch) {
  const existing = await getItem(nodeKey(groupId, nodeId))
  if (!existing || existing.deletedAt) return null

  const touchesStructuredName =
    patch.firstName !== undefined ||
    patch.lastName !== undefined ||
    patch.middleName !== undefined ||
    patch.birthName !== undefined

  if (patch.firstName !== undefined) {
    const firstName = typeof patch.firstName === 'string' ? patch.firstName.trim() : ''
    if (!firstName) throw new ValidationError('First name cannot be empty')
    patch = { ...patch, firstName }
  }

  const before = toNode(existing)
  const updated = { ...existing }
  applyWritable(updated, patch)
  // Legacy rows may still have only `name`; any structured-name patch must end
  // with a real firstName so we never persist a half-migrated row.
  if (touchesStructuredName) {
    const firstName = typeof updated.firstName === 'string' ? updated.firstName.trim() : ''
    if (!firstName) throw new ValidationError('Missing first name')
  }
  updated.updatedAt = new Date().toISOString()
  updated.updatedBy = accountId

  await putItem(updated)
  await appendLog(
    groupId,
    accountId,
    'update',
    'node',
    nodeId,
    before,
    toNode(updated),
  )
  return toNode(updated)
}

// Soft-delete a node and cascade the soft-delete to every edge that touches it,
// so the graph never keeps an edge pointing at a removed person. Returns false
// if the node was already gone.
export async function deleteNode(groupId, accountId, nodeId) {
  const existing = await getItem(nodeKey(groupId, nodeId))
  if (!existing || existing.deletedAt) return false

  const now = new Date().toISOString()
  await putItem({ ...existing, deletedAt: now, updatedAt: now, updatedBy: accountId })
  await appendLog(groupId, accountId, 'delete', 'node', nodeId, toNode(existing), null)

  const edges = await queryPrefix(`GROUP#${groupId}`, 'EDGE#')
  for (const edge of edges) {
    if (edge.deletedAt) continue
    if (edge.fromPerson === nodeId || edge.toPerson === nodeId) {
      await putItem({
        ...edge,
        deletedAt: now,
        updatedAt: now,
        updatedBy: accountId,
      })
      await appendLog(
        groupId,
        accountId,
        'delete',
        'edge',
        edge.edgeId,
        { edgeId: edge.edgeId, reason: 'cascade: node deleted' },
        null,
      )
    }
  }
  return true
}
