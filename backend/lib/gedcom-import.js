import { parseGedcom, gedcomToImport, gedcomTreeName } from './gedcom.js'
import { listNodes, getNode, createNode, updateNode, nodeFullName } from './nodes.js'
import { listEdges, putEdgeIfNew } from './edges.js'
import { ValidationError } from './errors.js'
import { scorePair, tierOf, WEIGHTS, norm, isEmpty } from './gedcom-match.js'

// Import orchestration: the DynamoDB-facing half of GEDCOM support. Parsing and
// field mapping live in lib/gedcom.js; the person-scoring model in
// lib/gedcom-match.js; here we tie them to the group's tree and apply writes.
//
// Import is two-phase so a shared family tree never gets a surprise bulk merge:
//   previewImport — parse, score every imported person against the tree, and
//                   hand back ranked match candidates (with field-level diffs
//                   and the relationships each person brings) — no writes.
//   commitImport  — apply the caller's per-person resolutions (create / merge /
//                   skip, with a chosen match and chosen fields), then wire up
//                   the relationships.
// The client re-sends the same GEDCOM text to commit, so nothing is staged
// server-side; both phases parse deterministically and key on the GEDCOM xref.

// Fields we carry from a GEDCOM individual onto a person_node. firstName is
// always present; the rest are nullable.
const FIELDS = ['firstName', 'middleName', 'lastName', 'birthdate', 'deathdate', 'notes']

// How many ranked candidates to surface per imported person.
const MAX_CANDIDATES = 3

// Derived full name of an imported person, for display.
function importedFullName(p) {
  return [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ')
}

// Project a person/node down to just the importable fields.
function pickFields(obj) {
  const out = {}
  for (const field of FIELDS) out[field] = obj[field] ?? null
  return out
}

// --- graph adjacency (for structural matching) --------------------------

// Existing tree: nodeId -> Set(neighbouring nodeId). Relation-agnostic — for
// "do these two share a relative" a shared neighbour of any kind is the signal.
function existingAdjacency(edges) {
  const adj = new Map()
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a).add(b)
  }
  for (const e of edges) {
    link(e.fromPerson, e.toPerson)
    link(e.toPerson, e.fromPerson)
  }
  return adj
}

// Imported file: xref -> Set(neighbouring xref), from the mapped edge list.
function importedAdjacency(edges) {
  const adj = new Map()
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a).add(b)
  }
  for (const e of edges) {
    link(e.from, e.to)
    link(e.to, e.from)
  }
  return adj
}

// --- field diff + relationships (for surfacing) -------------------------

// Per-field comparison of an imported person against a candidate node. Each
// entry is one of:
//   fill     — the tree has nothing; import can supply it (applied by default)
//   conflict — both sides have a value and they differ (caller chooses)
//   same     — identical, nothing to do (shown for context)
//   treeOnly — the tree has a value the import lacks (never overwritten)
function fieldDiffs(imported, existing) {
  const out = []
  for (const field of FIELDS) {
    const inc = imported[field]
    const cur = existing[field]
    const incEmpty = isEmpty(inc)
    const curEmpty = isEmpty(cur)
    if (incEmpty && curEmpty) continue
    let status
    if (incEmpty) status = 'treeOnly'
    else if (curEmpty) status = 'fill'
    else if (norm(cur) === norm(inc)) status = 'same'
    else status = 'conflict'
    out.push({
      field,
      status,
      existing: curEmpty ? null : cur,
      imported: incEmpty ? null : inc,
    })
  }
  return out
}

// The relationships an imported person brings, described from their point of
// view by the other endpoint's name and xref — so the caller can tell which
// ones are already in the tree vs genuinely new.
function personRelationships(p, edges, peopleByXref) {
  const out = []
  for (const e of edges) {
    let otherXref = null
    let relation = null
    if (e.kind === 'partner') {
      if (e.from === p.xref) [otherXref, relation] = [e.to, 'partner']
      else if (e.to === p.xref) [otherXref, relation] = [e.from, 'partner']
    } else {
      // parent_child: `from` is the parent, `to` is the child.
      if (e.from === p.xref) [otherXref, relation] = [e.to, 'child']
      else if (e.to === p.xref) [otherXref, relation] = [e.from, 'parent']
    }
    if (otherXref) {
      const other = peopleByXref.get(otherXref)
      out.push({ relation, otherXref, otherName: other ? importedFullName(other) : '(unknown)' })
    }
  }
  return out
}

const round1 = (n) => Math.round(n * 10) / 10

/**
 * Phase 1: parse a GEDCOM file and diff it against the group's current tree.
 * Pure read — nothing is written. For each imported person we score every
 * existing node (name + dates), then boost candidates who share a relative with
 * the person's other provisional matches (tree shape), and return the ranked
 * candidates with per-field diffs. `suggestedNodeId` is the default merge target
 * for a strong, unambiguous match; possible matches are surfaced but default to
 * "add as new" so the caller opts in.
 */
export async function previewImport(groupId, gedcomText) {
  const records = parseGedcom(gedcomText)
  const { people, edges } = gedcomToImport(records)

  const existing = await listNodes(groupId)
  const existingEdges = await listEdges(groupId)
  const exAdj = existingAdjacency(existingEdges)
  const impAdj = importedAdjacency(edges)

  // Pass 1 — name/date candidates. A pair needs a first-name link (exact,
  // nickname, typo, or initial) to qualify, so shared surnames alone don't turn
  // every relative into a candidate.
  const scored = people.map((p) => {
    const cands = []
    for (const node of existing) {
      const { score, reasons, firstSignal, birthExact } = scorePair(p, node)
      // Need a real first-name link (exact/nickname/typo) or an exact birth date
      // to qualify. A shared surname plus a shared first *initial* is not enough
      // — in a family tree that would flag half the relatives as maybes.
      const strongName = firstSignal !== null && firstSignal !== 'initial'
      if (!strongName && !birthExact) continue
      if (tierOf(score) === null) continue
      cands.push({ node, score, reasons: [...reasons] })
    }
    cands.sort((a, b) => b.score - a.score)
    return { p, cands }
  })

  // Provisional best match per person, so structural scoring has something to
  // point at.
  const provisional = new Map()
  for (const { p, cands } of scored) {
    if (cands.length) provisional.set(p.xref, cands[0].node.nodeId)
  }

  // Pass 2 — structural boost: a candidate that is a neighbour of this person's
  // other provisional matches is far more likely to be the real one.
  for (const { p, cands } of scored) {
    const neighbours = impAdj.get(p.xref) || new Set()
    for (const c of cands) {
      let shared = 0
      for (const ny of neighbours) {
        const mapped = provisional.get(ny)
        if (mapped && exAdj.get(c.node.nodeId)?.has(mapped)) shared += 1
      }
      if (shared) {
        c.score += Math.min(shared * WEIGHTS.sharedRelative, WEIGHTS.sharedRelativeCap)
        c.reasons.push(`shares ${shared} relative${shared > 1 ? 's' : ''} already in the tree`)
      }
    }
    cands.sort((a, b) => b.score - a.score)
  }

  // Default assignment: greedily give each strong candidate to its highest
  // scorer, so two imported people never both default to merging into the same
  // node (which would silently collapse distinct people).
  const flat = []
  scored.forEach(({ p, cands }) => {
    for (const c of cands) {
      if (tierOf(c.score) === 'strong') flat.push({ xref: p.xref, c })
    }
  })
  flat.sort((a, b) => b.c.score - a.c.score)
  const assigned = new Map()
  const claimed = new Set()
  for (const { xref, c } of flat) {
    if (assigned.has(xref) || claimed.has(c.node.nodeId)) continue
    assigned.set(xref, c.node.nodeId)
    claimed.add(c.node.nodeId)
  }

  const peopleByXref = new Map(people.map((pp) => [pp.xref, pp]))
  const stats = {
    people: people.length,
    relationships: edges.length,
    strongMatches: 0,
    possibleMatches: 0,
    newPeople: 0,
    // Suggested matches whose data + relationships are already fully in the tree
    // — the "nothing to add" people that a repeat import can hide.
    alreadyInTree: 0,
  }

  // A relationship already exists when both its endpoints resolve (by suggested
  // match) to nodes that are already connected in the tree — so a re-import of
  // the same file surfaces no "new" relationships.
  const relExists = (aXref, bXref) => {
    const a = assigned.get(aXref)
    const b = assigned.get(bXref)
    return !!(a && b && exAdj.get(a)?.has(b))
  }

  const toCandidate = (p, c) => ({
    nodeId: c.node.nodeId,
    name: nodeFullName(c.node),
    fields: pickFields(c.node),
    score: round1(c.score),
    tier: tierOf(c.score),
    reasons: c.reasons,
    // The node's updatedAt at preview time, echoed back on commit so a
    // concurrent edit can be caught (stale-merge guard).
    updatedAt: c.node.updatedAt,
    fieldDiffs: fieldDiffs(p, c.node),
  })

  const previewPeople = scored.map(({ p, cands }) => {
    let candidates = cands.slice(0, MAX_CANDIDATES).map((c) => toCandidate(p, c))
    const suggestedNodeId = assigned.get(p.xref) || null
    // Make sure the assigned node is always in the visible list (greedy
    // assignment can hand someone their #2 when #1 was claimed elsewhere).
    if (suggestedNodeId && !candidates.some((c) => c.nodeId === suggestedNodeId)) {
      const extra = cands.find((c) => c.node.nodeId === suggestedNodeId)
      if (extra) candidates = [toCandidate(p, extra), ...candidates].slice(0, MAX_CANDIDATES)
    }

    // Relationships this person brings, each flagged as new or already present.
    const relationships = personRelationships(p, edges, peopleByXref).map((r) => ({
      relation: r.relation,
      otherName: r.otherName,
      isNew: !relExists(p.xref, r.otherXref),
    }))
    const newRelationships = relationships.filter((r) => r.isNew).length

    // "Already in the tree": a suggested match with no field to fill/resolve and
    // no new relationship — nothing for the user to review on a repeat import.
    const suggested = suggestedNodeId
      ? candidates.find((c) => c.nodeId === suggestedNodeId)
      : null
    const hasFieldDelta = suggested
      ? suggested.fieldDiffs.some((d) => d.status === 'fill' || d.status === 'conflict')
      : false
    const alreadyInTree = Boolean(suggestedNodeId) && !hasFieldDelta && newRelationships === 0

    if (suggestedNodeId) stats.strongMatches += 1
    else if (candidates.length) stats.possibleMatches += 1
    else stats.newPeople += 1
    if (alreadyInTree) stats.alreadyInTree += 1

    return {
      xref: p.xref,
      fullName: importedFullName(p),
      fields: pickFields(p),
      candidates,
      suggestedNodeId,
      relationships,
      alreadyInTree,
    }
  })

  return { treeName: gedcomTreeName(records), stats, people: previewPeople }
}

/**
 * Phase 2: apply an import. `resolutions` maps a GEDCOM xref to how to handle
 * that person:
 *   { action: 'create' }                          — add as a new person (default)
 *   { action: 'skip' }                             — drop the person (and any
 *                                                     relationships touching them)
 *   { action: 'merge', nodeId, fields, updatedAt } — fold into an existing node,
 *                                                     writing the imported value
 *                                                     for each field in `fields`
 * A xref with no resolution defaults to 'create'. Relationships are wired last
 * via putEdgeIfNew (deduped against the tree and within the batch); a duplicate
 * or self-loop is counted as skipped rather than aborting the import.
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
      const applied = await mergePerson(
        groupId,
        accountId,
        res.nodeId,
        p,
        res.fields,
        res.updatedAt,
      )
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

  // Preload existing edges once so duplicate detection is O(1) per edge.
  const existingEdges = await listEdges(groupId)
  const pairsSeen = new Set(
    existingEdges.map((e) => [e.fromPerson, e.toPerson].sort().join('|')),
  )

  for (const e of edges) {
    const from = xrefToNode.get(e.from)
    const to = xrefToNode.get(e.to)
    if (!from || !to) {
      summary.relationshipsSkipped += 1
      continue
    }
    const created = await putEdgeIfNew(
      groupId,
      accountId,
      {
        edgeKind: e.kind,
        fromPerson: from,
        toPerson: to,
        subtype: e.subtype,
        startDate: e.startDate,
        endDate: e.endDate,
      },
      pairsSeen,
    )
    if (created) summary.relationshipsCreated += 1
    else summary.relationshipsSkipped += 1
  }

  return summary
}

// Fold an imported person into an existing node, writing the imported value for
// each requested field. Returns false if the target node is gone; throws
// ValidationError if the node was edited since the preview (stale-merge guard:
// `expectedUpdatedAt` comes from the preview and is echoed back in the
// resolution).
async function mergePerson(groupId, accountId, nodeId, imported, fields = [], expectedUpdatedAt = null) {
  const existing = await getNode(groupId, nodeId)
  if (!existing) return false

  if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) {
    throw new ValidationError(
      `"${nodeFullName(existing)}" was edited after the preview was generated — re-run the import preview to get fresh data`,
    )
  }

  const wanted = new Set(fields)
  const patch = {}
  for (const field of FIELDS) {
    if (!wanted.has(field)) continue
    const inc = imported[field]
    if (!isEmpty(inc)) patch[field] = inc
  }

  if (Object.keys(patch).length) {
    await updateNode(groupId, accountId, nodeId, patch)
  }
  return true
}
