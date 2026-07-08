import { getItem, putItem, queryIndexPrefix } from './dynamo.js'
import { newGroupId, newLogId } from './ids.js'

// All family-tree data lives under a group partition (GROUP#<groupId>), so
// group isolation reduces to a single membership check per request. This is
// the server-side enforcement of "family A can't see family B".

export class ForbiddenError extends Error {}

function groupMetaKey(groupId) {
  return { PK: `GROUP#${groupId}`, SK: 'META' }
}

function membershipKey(groupId, accountId) {
  return { PK: `GROUP#${groupId}`, SK: `MEMBER#${accountId}` }
}

// Throws ForbiddenError unless the account is an active member of the group.
// Call this at the top of every handler that touches group-scoped data.
export async function requireMember(groupId, accountId) {
  const member = await getItem(membershipKey(groupId, accountId))
  if (!member || member.deletedAt) {
    throw new ForbiddenError('Not a member of this group')
  }
  return member
}

// List the groups an account belongs to, via the GSI1 reverse lookup.
export async function listGroupsForAccount(accountId) {
  const memberships = await queryIndexPrefix(`ACCOUNT#${accountId}`, 'GROUP#')
  const active = memberships.filter((m) => !m.deletedAt)

  const groups = []
  for (const m of active) {
    const meta = await getItem(groupMetaKey(m.groupId))
    if (!meta || meta.deletedAt) continue
    groups.push({ groupId: m.groupId, name: meta.name, role: m.role })
  }
  return groups
}

// Create a group, make the caller its owner, and record the creation in the
// append-only edit log. (Phase 0 uses sequential writes; a later phase can
// wrap these in a DynamoDB transaction for atomicity.)
export async function createGroup(accountId, name) {
  const groupId = newGroupId()
  const now = new Date().toISOString()

  await putItem({
    ...groupMetaKey(groupId),
    groupId,
    name,
    createdAt: now,
    updatedAt: now,
    updatedBy: accountId,
    deletedAt: null,
  })

  await putItem({
    ...membershipKey(groupId, accountId),
    groupId,
    accountId,
    role: 'owner',
    // GSI1 reverse index: look up all groups for an account.
    GSI1PK: `ACCOUNT#${accountId}`,
    GSI1SK: `GROUP#${groupId}`,
    createdAt: now,
    updatedAt: now,
    updatedBy: accountId,
    deletedAt: null,
  })

  await appendLog(groupId, accountId, 'create', 'group', groupId, null, {
    name,
  })

  return { groupId, name, role: 'owner' }
}

// Append-only edit log entry. SK is LOG#<ulid>, which sorts chronologically.
export async function appendLog(
  groupId,
  actorAccountId,
  action,
  entityType,
  entityId,
  before,
  after,
) {
  const at = new Date().toISOString()
  await putItem({
    PK: `GROUP#${groupId}`,
    SK: `LOG#${newLogId()}`,
    actor: actorAccountId,
    action,
    entityType,
    entityId,
    before,
    after,
    at,
  })
}
