import { ulid } from 'ulid'

// Internal, provider-independent identifiers. We deliberately do NOT use the
// Google `sub` as an id anywhere in the data model — see lib/accounts.js.
export function newAccountId() {
  return `acc_${ulid()}`
}

export function newGroupId() {
  return `grp_${ulid()}`
}

export function newNodeId() {
  return `nod_${ulid()}`
}

export function newEdgeId() {
  return `edg_${ulid()}`
}

// Sortable log id — ULID is time-ordered, so LOG#<ulid> sorts chronologically.
export function newLogId() {
  return ulid()
}
