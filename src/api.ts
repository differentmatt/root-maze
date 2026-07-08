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
