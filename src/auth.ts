// Client-side auth state. We hold the Google ID token (a JWT) that Google
// Identity Services hands us, and send it as a Bearer token to our API.
// The server never trusts the client beyond this token — it re-verifies the
// JWT signature against Google's keys and maps the Google `sub` to an
// internal account id.

const STORAGE_KEY = 'rootmaze:credential'

type Listener = (credential: string | null) => void
const listeners = new Set<Listener>()

let credential: string | null = readStored()

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function getCredential(): string | null {
  return credential
}

export function setCredential(next: string): void {
  credential = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
  listeners.forEach((l) => l(credential))
}

export function clearCredential(): void {
  credential = null
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l(credential))
}

export function onCredentialChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Best-effort decode of the JWT payload for display only. NOT trusted for auth.
export function decodeEmail(token: string | null): string | null {
  if (!token) return null
  try {
    const payload = token.split('.')[1]
    const json = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    )
    return json.email ?? null
  } catch {
    return null
  }
}
