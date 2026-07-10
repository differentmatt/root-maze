export function ok(body) {
  return { statusCode: 200, body: JSON.stringify(body) }
}

export function badRequest(msg) {
  return { statusCode: 400, body: JSON.stringify({ error: msg }) }
}

export function unauthorized() {
  return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
}

export function forbidden() {
  return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) }
}

export function notFound(msg) {
  return { statusCode: 404, body: JSON.stringify({ error: msg || 'Not found' }) }
}

export function conflict(msg) {
  return { statusCode: 409, body: JSON.stringify({ error: msg || 'Conflict' }) }
}

// 410 Gone — the resource existed but is no longer valid (e.g. an expired or
// revoked invite). Distinct from 404 so the invitee UI can say "this invite has
// expired" rather than "not found".
export function gone(msg) {
  return { statusCode: 410, body: JSON.stringify({ error: msg || 'Gone' }) }
}

export function serverError(msg) {
  return { statusCode: 500, body: JSON.stringify({ error: msg }) }
}
