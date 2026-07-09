import { getItem, putItem, queryPrefix } from './dynamo.js'
import { newEdgeId } from './ids.js'
import { appendLog } from './groups.js'
import { getNode } from './nodes.js'
import { ValidationError } from './errors.js'

// edge rows live under the group partition (GROUP#<groupId>) with an
// EDGE#<edgeId> sort key. Two edge kinds, each with its own subtype vocabulary:
//   parent_child — fromPerson is the parent, toPerson is the child. Step/adopt/
//                  foster parents are explicit edges, never inferred from a
//                  partner edge, so traversal stays simple and history survives
//                  a partner edge changing.
//   partner      — an (unordered) union between two people; a person can have
//                  several over time (remarriage chains).
// startDate/endDate are free-form optional strings (birth/adoption/union date,
// and divorce/end date). Soft-delete + updatedAt/updatedBy as everywhere else.

export const EDGE_KINDS = ['parent_child', 'partner']

export const SUBTYPES = {
  parent_child: ['biological', 'step', 'adoptive', 'foster'],
  partner: ['partner', 'married', 'remarried', 'ex'],
}

export const DEFAULT_SUBTYPE = {
  parent_child: 'biological',
  partner: 'partner',
}

function edgeKey(groupId, edgeId) {
  return { PK: `GROUP#${groupId}`, SK: `EDGE#${edgeId}` }
}

function toEdge(item) {
  return {
    edgeId: item.edgeId,
    groupId: item.groupId,
    edgeKind: item.edgeKind,
    fromPerson: item.fromPerson,
    toPerson: item.toPerson,
    subtype: item.subtype,
    startDate: item.startDate ?? null,
    endDate: item.endDate ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
  }
}

export function isValidKind(kind) {
  return EDGE_KINDS.includes(kind)
}

// Validate a subtype against its kind. An empty/undefined subtype is allowed and
// resolves to the kind's default; a non-empty unknown value is rejected.
export function resolveSubtype(kind, subtype) {
  if (subtype === undefined || subtype === null || subtype === '') {
    return DEFAULT_SUBTYPE[kind]
  }
  if (!SUBTYPES[kind].includes(subtype)) {
    throw new ValidationError(`Invalid subtype "${subtype}" for ${kind}`)
  }
  return subtype
}

export async function listEdges(groupId) {
  const items = await queryPrefix(`GROUP#${groupId}`, 'EDGE#')
  return items.filter((i) => !i.deletedAt).map(toEdge)
}

export async function getEdge(groupId, edgeId) {
  const item = await getItem(edgeKey(groupId, edgeId))
  if (!item || item.deletedAt) return null
  return toEdge(item)
}

export async function createEdge(groupId, accountId, input) {
  const { edgeKind, fromPerson, toPerson } = input
  if (!isValidKind(edgeKind)) {
    throw new ValidationError('edgeKind must be parent_child or partner')
  }
  if (!fromPerson || !toPerson) {
    throw new ValidationError('fromPerson and toPerson are required')
  }
  if (fromPerson === toPerson) {
    throw new ValidationError('An edge cannot connect a person to themselves')
  }

  // Referential integrity: both endpoints must be live nodes in this group.
  const [from, to] = await Promise.all([
    getNode(groupId, fromPerson),
    getNode(groupId, toPerson),
  ])
  if (!from) throw new ValidationError('fromPerson does not exist in this group')
  if (!to) throw new ValidationError('toPerson does not exist in this group')

  // One relationship per pair: reject a second live edge between the same two
  // people, in either direction and of any kind. (Two people being both
  // partners and parent/child, or doubly-linked, is never what's meant.)
  const existing = await queryPrefix(`GROUP#${groupId}`, 'EDGE#')
  const duplicate = existing.some(
    (e) =>
      !e.deletedAt &&
      ((e.fromPerson === fromPerson && e.toPerson === toPerson) ||
        (e.fromPerson === toPerson && e.toPerson === fromPerson)),
  )
  if (duplicate) {
    throw new ValidationError(
      'These two people are already connected by a relationship',
    )
  }

  const subtype = resolveSubtype(edgeKind, input.subtype)
  const edgeId = newEdgeId()
  const now = new Date().toISOString()

  const item = {
    ...edgeKey(groupId, edgeId),
    edgeId,
    groupId,
    edgeKind,
    fromPerson,
    toPerson,
    subtype,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    createdAt: now,
    updatedAt: now,
    updatedBy: accountId,
    deletedAt: null,
  }

  await putItem(item)
  await appendLog(groupId, accountId, 'create', 'edge', edgeId, null, toEdge(item))
  return toEdge(item)
}

// Patch an edge. Endpoints and kind are immutable — changing who an edge
// connects is a delete + create — so only subtype/startDate/endDate are
// writable. Returns the updated edge, or null if it doesn't exist.
export async function updateEdge(groupId, accountId, edgeId, patch) {
  const existing = await getItem(edgeKey(groupId, edgeId))
  if (!existing || existing.deletedAt) return null

  const updated = { ...existing }
  if (patch.subtype !== undefined) {
    updated.subtype = resolveSubtype(existing.edgeKind, patch.subtype)
  }
  if (patch.startDate !== undefined) updated.startDate = patch.startDate
  if (patch.endDate !== undefined) updated.endDate = patch.endDate

  const before = toEdge(existing)
  updated.updatedAt = new Date().toISOString()
  updated.updatedBy = accountId

  await putItem(updated)
  await appendLog(
    groupId,
    accountId,
    'update',
    'edge',
    edgeId,
    before,
    toEdge(updated),
  )
  return toEdge(updated)
}

export async function deleteEdge(groupId, accountId, edgeId) {
  const existing = await getItem(edgeKey(groupId, edgeId))
  if (!existing || existing.deletedAt) return false

  const now = new Date().toISOString()
  await putItem({ ...existing, deletedAt: now, updatedAt: now, updatedBy: accountId })
  await appendLog(groupId, accountId, 'delete', 'edge', edgeId, toEdge(existing), null)
  return true
}
