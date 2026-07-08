import { createRemoteJWKSet, jwtVerify } from 'jose'

// Verify Google-issued ID tokens against Google's published keys. This is the
// only thing we trust from the client: a valid, unexpired token proves the
// caller controls the Google account with this `sub`.
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
)

export async function verifyToken(token) {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    return { sub: payload.sub, email: payload.email, name: payload.name }
  } catch {
    return null
  }
}

export async function authenticate(event) {
  const authHeader = event.headers?.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  return verifyToken(token)
}
