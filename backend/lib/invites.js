import { randomBytes } from 'node:crypto'
import { getItem, putItem, queryPrefix, queryIndexPrefix } from './dynamo.js'
import { appendLog, addMember, groupMetaKey } from './groups.js'
import { ValidationError } from './errors.js'

// Invites let a family share one group. An invite is a row under the group
// partition (GROUP#<id> / INVITE#<token>) that also carries GSI1 keys
//   GSI1PK = INVITE#<token>,  GSI1SK = GROUP#<groupId>
// so a bare token — all the shared link contains — resolves back to its group
// without leaking the groupId in the link. The token is 256 bits of CSPRNG
// randomness (base64url), so it can't be guessed or enumerated.
//
// Invites are multi-use within a window: they expire (default 7 days), can carry
// an optional max-use cap, and are revocable (soft-delete). Acceptance always
// grants the 'editor' role — owners are minted by creating a group or by an
// explicit role change, never by an invite, so a leaked link can't hand out
// ownership.

const DEFAULT_TTL_DAYS = 7
const MAX_TTL_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

function inviteKey(groupId, token) {
  return { PK: `GROUP#${groupId}`, SK: `INVITE#${token}` }
}

function newToken() {
  return randomBytes(32).toString('base64url')
}

// Public shape returned to group members managing invites. Never includes the
// PK/SK bookkeeping.
function toInvite(item) {
  return {
    token: item.token,
    groupId: item.groupId,
    role: item.role,
    expiresAt: item.expiresAt,
    maxUses: item.maxUses ?? null,
    useCount: item.useCount ?? 0,
    createdAt: item.createdAt,
    createdBy: item.createdBy,
  }
}

// An invite is spent when it's revoked, expired, or has hit its use cap.
function isSpent(item, now = new Date()) {
  if (!item || item.deletedAt) return true
  if (item.expiresAt && new Date(item.expiresAt).getTime() <= now.getTime()) return true
  if (item.maxUses != null && (item.useCount ?? 0) >= item.maxUses) return true
  return false
}

function clampTtlDays(input) {
  if (input == null) return DEFAULT_TTL_DAYS
  const n = Number(input)
  if (!Number.isFinite(n) || n < 1) throw new ValidationError('expiresInDays must be at least 1')
  return Math.min(Math.floor(n), MAX_TTL_DAYS)
}

function parseMaxUses(input) {
  if (input == null) return null
  const n = Number(input)
  if (!Number.isInteger(n) || n < 1) throw new ValidationError('maxUses must be a positive integer')
  return n
}

export async function createInvite(groupId, accountId, input = {}) {
  const now = new Date()
  const nowIso = now.toISOString()
  const ttlDays = clampTtlDays(input.expiresInDays)
  const maxUses = parseMaxUses(input.maxUses)
  const token = newToken()

  const item = {
    ...inviteKey(groupId, token),
    GSI1PK: `INVITE#${token}`,
    GSI1SK: `GROUP#${groupId}`,
    token,
    groupId,
    role: 'editor',
    expiresAt: new Date(now.getTime() + ttlDays * DAY_MS).toISOString(),
    maxUses,
    useCount: 0,
    createdAt: nowIso,
    createdBy: accountId,
    updatedAt: nowIso,
    updatedBy: accountId,
    deletedAt: null,
  }

  await putItem(item)
  await appendLog(groupId, accountId, 'create', 'invite', token, null, toInvite(item))
  return toInvite(item)
}

// Active (non-spent) invites for a group, for the management UI.
export async function listInvites(groupId) {
  const rows = await queryPrefix(`GROUP#${groupId}`, 'INVITE#')
  const now = new Date()
  return rows.filter((r) => !isSpent(r, now)).map(toInvite)
}

// Revoke an invite (soft-delete). Returns false if it doesn't exist / is gone.
export async function revokeInvite(groupId, accountId, token) {
  const existing = await getItem(inviteKey(groupId, token))
  if (!existing || existing.deletedAt) return false
  const now = new Date().toISOString()
  await putItem({ ...existing, deletedAt: now, updatedAt: now, updatedBy: accountId })
  await appendLog(groupId, accountId, 'delete', 'invite', token, toInvite(existing), null)
  return true
}

// Resolve a bare token to its stored invite row via GSI1. Returns null if no
// such token exists.
async function findByToken(token) {
  const rows = await queryIndexPrefix(`INVITE#${token}`)
  return rows[0] ?? null
}

// What an unauthenticated invitee sees before signing in: just enough to decide
// whether to join. Deliberately reveals nothing sensitive — no member list, no
// emails, no tree data, not even the groupId.
export async function previewInvite(token) {
  const invite = await findByToken(token)
  if (isSpent(invite)) return { valid: false }
  const meta = await getItem(groupMetaKey(invite.groupId))
  if (!meta || meta.deletedAt) return { valid: false }
  return { valid: true, groupName: meta.name }
}

// Accept an invite: add the caller to the invite's group and count the use.
// Idempotent — re-accepting when already a member is a success no-op. Returns
// { ok: false } for any invalid/expired/revoked/used-up token.
export async function acceptInvite(accountId, token) {
  const invite = await findByToken(token)
  if (isSpent(invite)) return { ok: false }

  const groupId = invite.groupId
  const meta = await getItem(groupMetaKey(groupId))
  if (!meta || meta.deletedAt) return { ok: false }

  const { role, added } = await addMember(groupId, accountId, accountId, invite.role)

  if (added) {
    // Only a fresh join consumes the invite; idempotent re-accepts don't.
    const fresh = await getItem(inviteKey(groupId, token))
    if (fresh && !fresh.deletedAt) {
      const now = new Date().toISOString()
      await putItem({
        ...fresh,
        useCount: (fresh.useCount ?? 0) + 1,
        updatedAt: now,
        updatedBy: accountId,
      })
    }
    await appendLog(groupId, accountId, 'accept', 'invite', token, null, { accountId, role })
  }

  return { ok: true, groupId, name: meta.name, role, added }
}
