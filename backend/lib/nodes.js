import { getItem, putItem, queryPrefix } from './dynamo.js'
import { newNodeId } from './ids.js'
import { appendLog } from './groups.js'
import { ValidationError } from './errors.js'

// person_node rows live under the group partition (GROUP#<groupId>) with a
// NODE#<nodeId> sort key, so a single partition query returns the whole graph's
// people. Every row carries updatedAt/updatedBy and a soft-delete deletedAt;
// accountId is nullable so a person can exist in the tree before (or without)
// ever signing in.

function nodeKey(groupId, nodeId) {
  return { PK: `GROUP#${groupId}`, SK: `NODE#${nodeId}` }
}

// Project a stored row down to the public shape the API returns — no PK/SK or
// soft-delete bookkeeping leaks to the client.
function toNode(item) {
  return {
    nodeId: item.nodeId,
    groupId: item.groupId,
    name: item.name,
    birthdate: item.birthdate ?? null,
    deathdate: item.deathdate ?? null,
    notes: item.notes ?? null,
    accountId: item.accountId ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
  }
}

// Fields a client may set on create or patch. Anything else in the body is
// ignored — clients can't write PK/SK, timestamps, or deletedAt. accountId is
// deliberately NOT writable here: identity linking has its own integrity-checked
// endpoint (see lib/links.js), so a plain node write can't bypass the
// one-account-per-node / one-node-per-account rules.
const WRITABLE = ['name', 'birthdate', 'deathdate', 'notes']

function applyWritable(target, input) {
  for (const field of WRITABLE) {
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
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new ValidationError('Missing person name')

  const nodeId = newNodeId()
  const now = new Date().toISOString()

  const item = {
    ...nodeKey(groupId, nodeId),
    nodeId,
    groupId,
    name,
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

  if (patch.name !== undefined) {
    const name = typeof patch.name === 'string' ? patch.name.trim() : ''
    if (!name) throw new ValidationError('Person name cannot be empty')
    patch = { ...patch, name }
  }

  const before = toNode(existing)
  const updated = { ...existing }
  applyWritable(updated, patch)
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
