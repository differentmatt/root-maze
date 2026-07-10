import { getItem, putItem, queryPrefix } from './dynamo.js'
import { appendLog, membershipKey } from './groups.js'

// Phase 3: identity linking — connect a signed-in account to a person_node.
//
// The link lives on the node itself: person_node.accountId names the member a
// person "is". A node is linked when accountId is set, unlinked when null. No
// new row type and no GSI keys — GSI1PK=ACCOUNT#<acct> is already claimed by
// membership rows, and small family graphs make a partition scan cheap, so the
// reverse lookup ("which node is this account?") is just a NODE# scan + filter,
// matching how the rest of the codebase reads whole graphs wholesale.
//
// Two integrity rules, both enforced here on every link:
//   1. a node -> at most one account (the single accountId field enforces it
//      structurally; a node already claimed by someone else is a conflict).
//   2. an account -> at most one node per group (before linking we clear any
//      other node the account already holds, so a re-link "moves" cleanly).
//
// Writes stay sequential and non-transactional, matching the rest of the app,
// but the final claim write is conditional so a concurrent claim flips into a
// conflict instead of silent last-write-wins. Every link/unlink preserves
// updatedAt/updatedBy and appends to the append-only edit_log.

function nodeKey(groupId, nodeId) {
  return { PK: `GROUP#${groupId}`, SK: `NODE#${nodeId}` }
}

// Live (non-soft-deleted) person_node rows for a group.
async function liveNodes(groupId) {
  const items = await queryPrefix(`GROUP#${groupId}`, 'NODE#')
  return items.filter((i) => !i.deletedAt)
}

// accountId -> { nodeId, name } for every account currently linked to a live
// node. Used to surface "who's who" in the members list.
export async function linkedNodeMap(groupId) {
  const nodes = await liveNodes(groupId)
  const map = {}
  for (const n of nodes) {
    if (n.accountId) map[n.accountId] = { nodeId: n.nodeId, name: n.name }
  }
  return map
}

// Link a member's account to a node. Returns { status: 'ok', nodeId } on
// success (including the idempotent already-linked case), or one of the string
// codes 'not_found_member' | 'not_found_node' | 'conflict'.
export async function linkAccountToNode(groupId, actorAccountId, targetAccountId, nodeId) {
  const membership = await getItem(membershipKey(groupId, targetAccountId))
  if (!membership || membership.deletedAt) return 'not_found_member'

  const node = await getItem(nodeKey(groupId, nodeId))
  if (!node || node.deletedAt) return 'not_found_node'

  if (node.accountId) {
    // Already this account's node — nothing to do.
    if (node.accountId === targetAccountId) return { status: 'ok', nodeId }
    // Claimed by someone else — the claimant (or an owner) must unlink first.
    return 'conflict'
  }

  const now = new Date().toISOString()

  const claimed = await putItem(
    { ...node, accountId: targetAccountId, updatedAt: now, updatedBy: actorAccountId },
    {
      conditionExpression:
        '(attribute_not_exists(accountId) OR accountId = :null) AND (attribute_not_exists(deletedAt) OR deletedAt = :null)',
      expressionAttributeValues: { ':null': null },
    },
  )
  if (!claimed) {
    const current = await getItem(nodeKey(groupId, nodeId))
    if (!current || current.deletedAt) return 'not_found_node'
    if (current.accountId === targetAccountId) return { status: 'ok', nodeId }
    return 'conflict'
  }

  // Enforce one-node-per-account: unlink any other node this account holds so a
  // "this is actually me" correction moves the link instead of duplicating it.
  const nodes = await liveNodes(groupId)
  for (const other of nodes) {
    if (other.accountId === targetAccountId && other.nodeId !== nodeId) {
      await putItem({ ...other, accountId: null, updatedAt: now, updatedBy: actorAccountId })
      await appendLog(
        groupId,
        actorAccountId,
        'unlink',
        'node',
        other.nodeId,
        { nodeId: other.nodeId, accountId: targetAccountId },
        { nodeId: other.nodeId, accountId: null },
      )
    }
  }

  await appendLog(
    groupId,
    actorAccountId,
    'link',
    'node',
    nodeId,
    { nodeId, accountId: null },
    { nodeId, accountId: targetAccountId },
  )
  return { status: 'ok', nodeId }
}

// Unlink whatever node the target account currently holds. Returns
// { status: 'ok', nodeId } or 'not_found' if the account isn't linked.
export async function unlinkAccount(groupId, actorAccountId, targetAccountId) {
  const nodes = await liveNodes(groupId)
  const linked = nodes.filter((n) => n.accountId === targetAccountId)
  if (linked.length === 0) return 'not_found'

  const now = new Date().toISOString()
  for (const node of linked) {
    await putItem({ ...node, accountId: null, updatedAt: now, updatedBy: actorAccountId })
    await appendLog(
      groupId,
      actorAccountId,
      'unlink',
      'node',
      node.nodeId,
      { nodeId: node.nodeId, accountId: targetAccountId },
      { nodeId: node.nodeId, accountId: null },
    )
  }
  return { status: 'ok', nodeId: linked[0].nodeId }
}
