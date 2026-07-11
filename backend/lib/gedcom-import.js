import { parseGedcom, gedcomToImport, gedcomTreeName } from './gedcom.js'
import { listNodes, getNode, createNode, updateNode, nodeFullName } from './nodes.js'
import { createEdge } from './edges.js'
import { ValidationError } from './errors.js'

// Import orchestration: the DynamoDB-facing half of GEDCOM support. Parsing and
// field mapping live in the pure lib/gedcom.js; here we match imported people
// against a group's existing tree and apply the writes.
//
// Import is two-phase so a shared family tree never gets a surprise bulk merge:
//   previewImport — parse + map + match, and hand back a diff (new people,
//                   likely-duplicate matches, and per-field conflicts) with no
//                   writes at all.
//   commitImport  — take the caller's per-person resolutions (create / merge /
//                   skip) and apply them, then wire up the relationships.
// The client re-sends the same GEDCOM text to commit, so no server-side staging
// is needed; both phases parse deterministically and key everything on the
// GEDCOM xref.

// Fields we carry from a GEDCOM individual onto a person_node. firstName is
// always present; the rest are nullable.
const FIELDS = ['firstName', 'middleName', 'lastName', 'birthdate', 'deathdate', 'notes']

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const isEmpty = (v) => v === null || v === undefined || String(v).trim() === ''

// Derived full name of an imported person, for display + match keying.
function importedFullName(p) {
  return [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ')
}

// Pick the best existing node an imported person could be, from the nodes that
// share a (normalized) full name. A shared birthdate is the tiebreaker; with no
// birthdate to go on we fall back to the first same-name node.
function chooseMatch(imported, candidates) {
  if (!candidates || !candidates.length) return null
  if (!isEmpty(imported.birthdate)) {
    const exact = candidates.find((c) => norm(c.birthdate) === norm(imported.birthdate))
    if (exact) return exact
    // A same-name person with a *different* stated birthdate is more likely a
    // different individual than a match, so don't suggest one.
    const someKnown = candidates.some((c) => !isEmpty(c.birthdate))
    if (someKnown) return null
  }
  return candidates[0]
}

// Compare an imported person to a matched node, splitting the differences into
// `fills` (the tree has nothing, import can supply it — applied automatically on
// merge) and `conflicts` (both sides disagree — the caller must choose).
function diffFields(imported, existing) {
  const fills = []
  const conflicts = []
  for (const field of FIELDS) {
    const inc = imported[field]
    if (isEmpty(inc)) continue
    const cur = existing[field]
    if (isEmpty(cur)) fills.push({ field, imported: inc })
    else if (norm(cur) !== norm(inc)) {
      conflicts.push({ field, existing: cur, imported: inc })
    }
  }
  return { fills, conflicts }
}

/**
 * Phase 1: parse a GEDCOM file and diff it against the group's current tree.
 * Pure read — nothing is written. Returns the tree name advertised in the file
 * (for pre-filling a new group's name), overall stats, and a per-person entry
 * carrying the mapped fields plus any suggested match with its field diff.
 */
export async function previewImport(groupId, gedcomText) {
  const records = parseGedcom(gedcomText)
  const { people, edges } = gedcomToImport(records)

  const existing = await listNodes(groupId)
  const byName = new Map()
  for (const node of existing) {
    const key = norm(nodeFullName(node))
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(node)
  }

  let matched = 0
  const preview = people.map((p) => {
    const match = chooseMatch(p, byName.get(norm(importedFullName(p))))
    let matchInfo = null
    if (match) {
      matched += 1
      const { fills, conflicts } = diffFields(p, match)
      matchInfo = {
        nodeId: match.nodeId,
        name: nodeFullName(match),
        fills,
        conflicts,
      }
    }
    return {
      xref: p.xref,
      fullName: importedFullName(p),
      fields: pickFields(p),
      match: matchInfo,
    }
  })

  return {
    treeName: gedcomTreeName(records),
    stats: {
      people: people.length,
      relationships: edges.length,
      matches: matched,
      newPeople: people.length - matched,
    },
    people: preview,
  }
}

function pickFields(p) {
  const out = {}
  for (const field of FIELDS) out[field] = p[field] ?? null
  return out
}

/**
 * Phase 2: apply an import. `resolutions` maps a GEDCOM xref to how to handle
 * that person:
 *   { action: 'create' }                         — add as a new person (default)
 *   { action: 'skip' }                            — drop the person (and any
 *                                                    relationships touching them)
 *   { action: 'merge', nodeId, overwrite: [...] } — fold into an existing node;
 *                                                    empty fields are filled and
 *                                                    listed `overwrite` fields win
 * A xref with no resolution defaults to 'create'. Relationships are wired last,
 * reusing createEdge (so its referential-integrity and one-relationship-per-pair
 * rules apply); a relationship that would duplicate or self-loop is counted as
 * skipped rather than aborting the whole import.
 */
export async function commitImport(groupId, accountId, gedcomText, resolutions = {}) {
  const records = parseGedcom(gedcomText)
  const { people, edges } = gedcomToImport(records)

  const summary = {
    created: 0,
    merged: 0,
    skipped: 0,
    relationshipsCreated: 0,
    relationshipsSkipped: 0,
  }
  const xrefToNode = new Map()

  for (const p of people) {
    const res = resolutions[p.xref] || { action: 'create' }

    if (res.action === 'skip') {
      summary.skipped += 1
      continue
    }

    if (res.action === 'merge' && res.nodeId) {
      const applied = await mergePerson(groupId, accountId, res.nodeId, p, res.overwrite)
      if (applied) {
        xrefToNode.set(p.xref, res.nodeId)
        summary.merged += 1
        continue
      }
      // Merge target vanished (concurrent delete): fall through to create so we
      // don't silently lose the person.
    }

    const node = await createNode(groupId, accountId, pickFields(p))
    xrefToNode.set(p.xref, node.nodeId)
    summary.created += 1
  }

  for (const e of edges) {
    const from = xrefToNode.get(e.from)
    const to = xrefToNode.get(e.to)
    if (!from || !to) {
      summary.relationshipsSkipped += 1
      continue
    }
    try {
      await createEdge(groupId, accountId, {
        edgeKind: e.kind,
        fromPerson: from,
        toPerson: to,
        subtype: e.subtype,
        startDate: e.startDate,
        endDate: e.endDate,
      })
      summary.relationshipsCreated += 1
    } catch (err) {
      // A pair already connected (or a self-loop from two xrefs merged into one
      // node) is expected during a merge — skip it, don't fail the import.
      if (err instanceof ValidationError) summary.relationshipsSkipped += 1
      else throw err
    }
  }

  return summary
}

// Fold an imported person into an existing node: fill empty fields, and
// overwrite the named ones. Returns false if the target node is gone.
async function mergePerson(groupId, accountId, nodeId, imported, overwrite = []) {
  const existing = await getNode(groupId, nodeId)
  if (!existing) return false

  const over = new Set(overwrite)
  const patch = {}
  for (const field of FIELDS) {
    const inc = imported[field]
    if (isEmpty(inc)) continue
    const cur = existing[field]
    if (isEmpty(cur)) patch[field] = inc
    else if (over.has(field) && norm(cur) !== norm(inc)) patch[field] = inc
  }

  if (Object.keys(patch).length) {
    await updateNode(groupId, accountId, nodeId, patch)
  }
  return true
}
