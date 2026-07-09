import { getItem, putItem, queryPrefix, queryIndexPrefix } from './dynamo.js'
import { newGroupId, newLogId } from './ids.js'
import { ValidationError } from './errors.js'

export const ROLES = ['owner', 'editor']

// All family-tree data lives under a group partition (GROUP#<groupId>), so
// group isolation reduces to a single membership check per request. This is
// the server-side enforcement of "family A can't see family B".

export class ForbiddenError extends Error {}

export function groupMetaKey(groupId) {
  return { PK: `GROUP#${groupId}`, SK: 'META' }
}

export function membershipKey(groupId, accountId) {
  return { PK: `GROUP#${groupId}`, SK: `MEMBER#${accountId}` }
}

function accountMetaKey(accountId) {
  return { PK: `ACCOUNT#${accountId}`, SK: 'META' }
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

// --- Phase 2: membership management ---
//
// Membership rows (GROUP#<id> / MEMBER#<acct>) already exist from Phase 0; here
// we add the readers and writers that let a group have more than its creator.
// Every mutation soft-deletes / patches in place and appends to the edit log,
// and `requireMember` above already treats a soft-deleted row as "not a member",
// so revoking access needs no special-casing anywhere else.

// Live membership rows for a group (soft-deleted rows excluded).
async function activeMemberships(groupId) {
  const rows = await queryPrefix(`GROUP#${groupId}`, 'MEMBER#')
  return rows.filter((m) => !m.deletedAt)
}

// A group must always keep at least one owner, so we never let the last owner be
// removed or demoted — otherwise the graph would be orphaned with no one able to
// manage it.
async function activeOwnerCount(groupId) {
  const members = await activeMemberships(groupId)
  return members.filter((m) => m.role === 'owner').length
}

// List a group's members, enriched with each account's email/name for display.
// The membership row itself only stores the accountId + role.
export async function listMembers(groupId) {
  const members = await activeMemberships(groupId)
  const out = []
  for (const m of members) {
    const account = await getItem(accountMetaKey(m.accountId))
    out.push({
      accountId: m.accountId,
      role: m.role,
      email: account?.email ?? null,
      name: account?.name ?? null,
      joinedAt: m.createdAt,
    })
  }
  return out
}

// Soft-delete a membership. Returns 'ok', 'not_found' if there's no live
// membership, or 'last_owner' if this would remove the group's only owner.
export async function removeMember(groupId, actorAccountId, targetAccountId) {
  const existing = await getItem(membershipKey(groupId, targetAccountId))
  if (!existing || existing.deletedAt) return 'not_found'
  if (existing.role === 'owner' && (await activeOwnerCount(groupId)) <= 1) {
    return 'last_owner'
  }

  const now = new Date().toISOString()
  const before = { accountId: targetAccountId, role: existing.role }
  await putItem({
    ...existing,
    deletedAt: now,
    updatedAt: now,
    updatedBy: actorAccountId,
  })
  await appendLog(groupId, actorAccountId, 'delete', 'member', targetAccountId, before, null)
  return 'ok'
}

// Change a member's role. Returns 'ok', 'not_found', 'invalid_role', or
// 'last_owner' if demoting the group's only owner.
export async function changeMemberRole(groupId, actorAccountId, targetAccountId, role) {
  if (!ROLES.includes(role)) throw new ValidationError('Invalid role')
  const existing = await getItem(membershipKey(groupId, targetAccountId))
  if (!existing || existing.deletedAt) return 'not_found'
  if (existing.role === role) return { status: 'ok', role }
  if (existing.role === 'owner' && role !== 'owner' && (await activeOwnerCount(groupId)) <= 1) {
    return 'last_owner'
  }

  const now = new Date().toISOString()
  const before = { accountId: targetAccountId, role: existing.role }
  await putItem({ ...existing, role, updatedAt: now, updatedBy: actorAccountId })
  await appendLog(groupId, actorAccountId, 'update', 'member', targetAccountId, before, {
    accountId: targetAccountId,
    role,
  })
  return { status: 'ok', role }
}

// Add (or revive) a membership for an account. Used by invite acceptance, which
// is why it lives here next to the other membership writers. Idempotent: if the
// account is already an active member, its existing role is kept. Returns the
// effective role.
export async function addMember(groupId, actorAccountId, accountId, role) {
  const now = new Date().toISOString()
  const existing = await getItem(membershipKey(groupId, accountId))
  if (existing && !existing.deletedAt) {
    return { role: existing.role, added: false }
  }

  await putItem({
    ...membershipKey(groupId, accountId),
    groupId,
    accountId,
    role,
    GSI1PK: `ACCOUNT#${accountId}`,
    GSI1SK: `GROUP#${groupId}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    updatedBy: actorAccountId,
    deletedAt: null,
  })
  await appendLog(groupId, actorAccountId, 'create', 'member', accountId, null, {
    accountId,
    role,
  })
  return { role, added: true }
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
