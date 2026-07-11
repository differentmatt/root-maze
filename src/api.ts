// Thin fetch wrapper. The API is served same-origin under /api/* (CloudFront
// routes it to API Gateway), so no base URL or CORS is needed in the browser.

import { getCredential, clearCredential } from './auth'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const credential = getCredential()
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401) {
    // Token expired or invalid — drop it so the UI returns to signed-out.
    clearCredential()
    throw new ApiError(401, 'Unauthorized')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ApiError(res.status, text || res.statusText)
  }
  return res.json() as Promise<T>
}

export interface Group {
  groupId: string
  name: string
  role: string
}

export interface Me {
  accountId: string
  email: string | null
  groups: Group[]
}

export function getMe(): Promise<Me> {
  return request<Me>('GET', '/me')
}

export function createGroup(name: string): Promise<Group> {
  return request<Group>('POST', '/groups', { name })
}

// Rename a group. Any member may rename (membership management is deliberately
// low-friction); the server enforces membership and a ≤100-char name.
export function renameGroup(
  groupId: string,
  name: string,
): Promise<{ groupId: string; name: string }> {
  return request<{ groupId: string; name: string }>(
    'PATCH',
    `/groups/${groupId}`,
    { name },
  )
}

// --- Phase 1: people (person_node) and relationships (edge) ---

export interface PersonNode {
  nodeId: string
  groupId: string
  // Derived full name ("First Middle Last"), always present — legacy rows that
  // predate structured names resolve to their original single string here.
  name: string
  firstName: string | null
  lastName: string | null
  middleName: string | null
  // Name at birth / former name, surfaced as "born …" in the UI.
  birthName: string | null
  birthdate: string | null
  deathdate: string | null
  notes: string | null
  accountId: string | null
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export type EdgeKind = 'parent_child' | 'partner'

export interface Edge {
  edgeId: string
  groupId: string
  edgeKind: EdgeKind
  fromPerson: string
  toPerson: string
  subtype: string
  startDate: string | null
  endDate: string | null
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export interface Graph {
  nodes: PersonNode[]
  edges: Edge[]
}

// Subtype vocabularies, mirrored from backend/lib/edges.js. The first entry is
// the default the server falls back to when none is supplied.
export const SUBTYPES: Record<EdgeKind, string[]> = {
  parent_child: ['biological', 'step', 'adoptive', 'foster'],
  partner: ['partner', 'married', 'remarried', 'ex'],
}

export interface NodeInput {
  firstName?: string
  lastName?: string | null
  middleName?: string | null
  birthName?: string | null
  birthdate?: string | null
  deathdate?: string | null
  notes?: string | null
  accountId?: string | null
}

export interface EdgeInput {
  edgeKind: EdgeKind
  fromPerson: string
  toPerson: string
  subtype?: string
  startDate?: string | null
  endDate?: string | null
}

export function getGraph(groupId: string): Promise<Graph> {
  return request<Graph>('GET', `/groups/${groupId}/graph`)
}

export function createNode(
  groupId: string,
  input: NodeInput,
): Promise<PersonNode> {
  return request<PersonNode>('POST', `/groups/${groupId}/nodes`, input)
}

export function updateNode(
  groupId: string,
  nodeId: string,
  patch: NodeInput,
): Promise<PersonNode> {
  return request<PersonNode>('PATCH', `/groups/${groupId}/nodes/${nodeId}`, patch)
}

export function deleteNode(
  groupId: string,
  nodeId: string,
): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    'DELETE',
    `/groups/${groupId}/nodes/${nodeId}`,
  )
}

export function createEdge(groupId: string, input: EdgeInput): Promise<Edge> {
  return request<Edge>('POST', `/groups/${groupId}/edges`, input)
}

export function updateEdge(
  groupId: string,
  edgeId: string,
  patch: Partial<Pick<EdgeInput, 'subtype' | 'startDate' | 'endDate'>>,
): Promise<Edge> {
  return request<Edge>('PATCH', `/groups/${groupId}/edges/${edgeId}`, patch)
}

export function deleteEdge(
  groupId: string,
  edgeId: string,
): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    'DELETE',
    `/groups/${groupId}/edges/${edgeId}`,
  )
}

// --- Phase 2: membership + invites ---

export type Role = 'owner' | 'editor'

export interface Member {
  accountId: string
  role: Role
  email: string | null
  name: string | null
  joinedAt: string
  // Phase 3: the person_node this member is linked to (their "this is me"), or
  // null if they haven't claimed anyone in the tree yet.
  linkedNodeId: string | null
  linkedNodeName: string | null
}

export interface MembersResult {
  members: Member[]
  me: string
}

export interface Invite {
  token: string
  groupId: string
  role: Role
  expiresAt: string
  maxUses: number | null
  useCount: number
  createdAt: string
  createdBy: string
}

export interface CreateInviteInput {
  expiresInDays?: number
  maxUses?: number | null
}

// What an unauthenticated invitee sees before signing in.
export interface InvitePreview {
  valid: boolean
  groupName?: string
}

export function getMembers(groupId: string): Promise<MembersResult> {
  return request<MembersResult>('GET', `/groups/${groupId}/members`)
}

export function removeMember(
  groupId: string,
  accountId: string,
): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>(
    'DELETE',
    `/groups/${groupId}/members/${accountId}`,
  )
}

export function changeMemberRole(
  groupId: string,
  accountId: string,
  role: Role,
): Promise<{ accountId: string; role: Role }> {
  return request<{ accountId: string; role: Role }>(
    'PATCH',
    `/groups/${groupId}/members/${accountId}`,
    { role },
  )
}

export function getInvites(groupId: string): Promise<{ invites: Invite[] }> {
  return request<{ invites: Invite[] }>('GET', `/groups/${groupId}/invites`)
}

export function createInvite(
  groupId: string,
  input: CreateInviteInput = {},
): Promise<Invite> {
  return request<Invite>('POST', `/groups/${groupId}/invites`, input)
}

export function revokeInvite(
  groupId: string,
  token: string,
): Promise<{ revoked: boolean }> {
  return request<{ revoked: boolean }>(
    'DELETE',
    `/groups/${groupId}/invites/${encodeURIComponent(token)}`,
  )
}

// Public preview — no auth required (the wrapper simply omits the Bearer header
// when there's no credential).
export function previewInvite(token: string): Promise<InvitePreview> {
  return request<InvitePreview>('GET', `/invites/${encodeURIComponent(token)}`)
}

export function acceptInvite(
  token: string,
): Promise<{ groupId: string; name: string; role: Role }> {
  return request<{ groupId: string; name: string; role: Role }>(
    'POST',
    `/invites/${encodeURIComponent(token)}/accept`,
  )
}

// Build a shareable invite URL from a token, pointing at this app's origin.
export function inviteUrl(token: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`
}

// --- Phase 3: identity linking (account <-> person_node) ---

// Link a member's account to a person in the tree. A member may link their own
// account; linking another member's account is owner-only (enforced server-side).
export function linkPersonNode(
  groupId: string,
  accountId: string,
  nodeId: string,
): Promise<{ accountId: string; nodeId: string }> {
  return request('PUT', `/groups/${groupId}/members/${accountId}/link`, { nodeId })
}

// Remove a member's link to whatever person they're currently claiming.
export function unlinkPersonNode(
  groupId: string,
  accountId: string,
): Promise<{ accountId: string; nodeId: string; unlinked: boolean }> {
  return request('DELETE', `/groups/${groupId}/members/${accountId}/link`)
}

// --- GEDCOM import / export ---
//
// Import is two-phase: previewImport diffs a file against the tree (no writes),
// then commitImport applies the caller's per-person resolutions. The client
// re-sends the same GEDCOM text on commit, so nothing is staged server-side.

// The fields we carry from a GEDCOM individual onto a person.
export interface ImportedFields {
  firstName: string | null
  middleName: string | null
  lastName: string | null
  birthdate: string | null
  deathdate: string | null
  notes: string | null
}

// Per-field comparison of an imported person against a candidate node:
//   fill     — tree is empty, import can supply it (applied by default)
//   conflict — both differ; the user chooses whether to overwrite
//   same     — identical (shown for context)
//   treeOnly — tree has a value the import lacks (never overwritten)
export type FieldDiffStatus = 'same' | 'fill' | 'conflict' | 'treeOnly'

export interface FieldDiff {
  field: keyof ImportedFields
  status: FieldDiffStatus
  existing: string | null
  imported: string | null
}

// A ranked existing-person candidate for an imported record.
export interface MatchCandidate {
  nodeId: string
  name: string
  fields: ImportedFields
  score: number
  tier: 'strong' | 'possible'
  reasons: string[]
  // The node's updatedAt at preview time, echoed back on merge so the server
  // can reject a stale merge.
  updatedAt: string
  fieldDiffs: FieldDiff[]
}

// A relationship the imported person brings, named by the other endpoint.
// `isNew` is false when both endpoints already exist and are connected in the
// tree — so a repeat import shows nothing new.
export interface ImportRelationship {
  relation: 'partner' | 'parent' | 'child'
  otherName: string
  isNew: boolean
}

export interface ImportPerson {
  xref: string
  fullName: string
  fields: ImportedFields
  candidates: MatchCandidate[]
  // The default merge target for a strong, unambiguous match, or null.
  suggestedNodeId: string | null
  relationships: ImportRelationship[]
  // A suggested match whose fields and relationships are all already present —
  // nothing to review. The UI collapses these on a repeat import.
  alreadyInTree: boolean
}

export interface ImportPreview {
  treeName: string | null
  stats: {
    people: number
    relationships: number
    strongMatches: number
    possibleMatches: number
    newPeople: number
    alreadyInTree: number
  }
  people: ImportPerson[]
}

// How to handle one imported person on commit, keyed by GEDCOM xref. On merge,
// `fields` lists which imported fields to write onto the existing node.
export type ImportResolution =
  | { action: 'create' }
  | { action: 'skip' }
  | { action: 'merge'; nodeId: string; fields: string[]; updatedAt: string }

export interface ImportSummary {
  created: number
  merged: number
  skipped: number
  relationshipsCreated: number
  relationshipsSkipped: number
}

export function previewImport(
  groupId: string,
  gedcom: string,
): Promise<ImportPreview> {
  return request<ImportPreview>('POST', `/groups/${groupId}/import/preview`, {
    gedcom,
  })
}

export function commitImport(
  groupId: string,
  gedcom: string,
  resolutions: Record<string, ImportResolution>,
): Promise<ImportSummary> {
  return request<ImportSummary>('POST', `/groups/${groupId}/import/commit`, {
    gedcom,
    resolutions,
  })
}

export function exportGedcom(
  groupId: string,
): Promise<{ gedcom: string; filename: string }> {
  return request<{ gedcom: string; filename: string }>(
    'GET',
    `/groups/${groupId}/export`,
  )
}
