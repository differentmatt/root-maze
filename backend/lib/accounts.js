import { getItem, putItem } from './dynamo.js'
import { newAccountId } from './ids.js'

// Map an external Google identity to our internal account.
//
// We never store the Google `sub` as an id. Instead we keep a lookup item:
//   AUTH#GOOGLE#<sub>  ->  { accountId }
// and a separate account record keyed by our own ULID:
//   ACCOUNT#<accountId>
// This lets a person keep one stable account id even if we add other login
// providers later, and lets us reference a person from a family-tree node
// (person_node.account_id) before they have ever signed in.

function authKey(sub) {
  return { PK: `AUTH#GOOGLE#${sub}`, SK: 'META' }
}

function accountKey(accountId) {
  return { PK: `ACCOUNT#${accountId}`, SK: 'META' }
}

export async function resolveAccount(user) {
  const existing = await getItem(authKey(user.sub))
  if (existing) {
    return { accountId: existing.accountId, email: user.email ?? null }
  }

  const accountId = newAccountId()
  const now = new Date().toISOString()

  // Create the provider link first, guarded against a concurrent sign-in of
  // the same Google account. If we lose that race, adopt the id that won.
  const created = await putItem(
    { ...authKey(user.sub), accountId, createdAt: now },
    'attribute_not_exists(PK)',
  )
  if (!created) {
    const winner = await getItem(authKey(user.sub))
    return { accountId: winner.accountId, email: user.email ?? null }
  }

  await putItem({
    ...accountKey(accountId),
    email: user.email ?? null,
    name: user.name ?? null,
    createdAt: now,
    updatedAt: now,
  })
  return { accountId, email: user.email ?? null }
}
