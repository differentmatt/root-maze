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

// --- Phase 1: people (person_node) and relationships (edge) ---

export interface PersonNode {
  nodeId: string
  groupId: string
  name: string
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
  name?: string
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
