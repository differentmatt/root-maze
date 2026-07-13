// Context-aware ordering for the person drop-down (PersonPicker). The picker
// itself is order-preserving; the "which person is most likely?" judgement lives
// here so it can be reused by both call sites and unit-tested in isolation.
//
// Every ranker returns a Suggested tier (a short, scored shortlist of the most
// contextually likely people) and the Rest (everyone else, alphabetical). When
// there's no real signal the Suggested tier is empty and the caller just shows a
// clean alphabetical list — never worse than the old insertion-order behaviour.

import type { Graph, Member, PersonNode } from '../api'
import { suggestOtherParents } from '../tree/suggestions'

// The reference person is `[choice]` the person being picked, mirroring
// TreeView's RelationshipFields select: e.g. `child_of` means the picked person
// is a *parent* of the reference person.
export type RelChoice = 'child_of' | 'parent_of' | 'partner_of'

export interface RankedSuggestion {
  node: PersonNode
  // A short reason shown as the option's dim second line ("partner of Ada").
  hint?: string
}

export interface RankedCandidates {
  suggested: RankedSuggestion[]
  rest: PersonNode[]
}

const MAX_SUGGESTED = 5

function byName(a: PersonNode, b: PersonNode): number {
  return a.name.localeCompare(b.name)
}

// A live surname to compare on: last name, falling back to birth name.
function surnameOf(n: {
  lastName?: string | null
  birthName?: string | null
}): string {
  return (n.lastName || n.birthName || '').trim().toLowerCase()
}

// Split a ranked map into the {suggested, rest} shape: the highest-scoring
// people (score > 0) become the Suggested tier, capped and ordered by score then
// name; everyone else falls to an alphabetical Rest. `hints` supplies the reason
// line for suggested rows.
function partition(
  candidates: PersonNode[],
  scores: Map<string, number>,
  hints: Map<string, string>,
): RankedCandidates {
  const scored = candidates
    .filter((n) => (scores.get(n.nodeId) ?? 0) > 0)
    .sort(
      (a, b) =>
        (scores.get(b.nodeId) ?? 0) - (scores.get(a.nodeId) ?? 0) ||
        byName(a, b),
    )
  const suggested = scored.slice(0, MAX_SUGGESTED)
  const suggestedIds = new Set(suggested.map((n) => n.nodeId))
  const rest = candidates
    .filter((n) => !suggestedIds.has(n.nodeId))
    .sort(byName)
  return {
    suggested: suggested.map((node) => ({
      node,
      hint: hints.get(node.nodeId),
    })),
    rest,
  }
}

// --- graph adjacency helpers -------------------------------------------------

function parentsOf(graph: Graph, id: string): string[] {
  return graph.edges
    .filter((e) => e.edgeKind === 'parent_child' && e.toPerson === id)
    .map((e) => e.fromPerson)
}

function childrenOf(graph: Graph, id: string): string[] {
  return graph.edges
    .filter((e) => e.edgeKind === 'parent_child' && e.fromPerson === id)
    .map((e) => e.toPerson)
}

function partnersOf(graph: Graph, id: string): string[] {
  return graph.edges
    .filter(
      (e) =>
        e.edgeKind === 'partner' &&
        (e.fromPerson === id || e.toPerson === id),
    )
    .map((e) => (e.fromPerson === id ? e.toPerson : e.fromPerson))
}

// Everyone one relationship-hop from `id` (parents, children, partners) — the
// basis for the generic "shares a relative" proximity boost.
function neighborsOf(graph: Graph, id: string): Set<string> {
  return new Set([
    ...parentsOf(graph, id),
    ...childrenOf(graph, id),
    ...partnersOf(graph, id),
  ])
}

/**
 * Rank the people offered when adding a relationship to `person`. Signals, in
 * rough priority order:
 *  - the relationship-specific "likely other party" (a co-parent for a partner,
 *    a partner-of-a-parent for a parent, a partner's child for a child);
 *  - shared relatives with the reference person (structural proximity);
 *  - a matching surname.
 *
 * `candidates` is expected to already exclude the reference person and anyone
 * already connected to them (TreeView filters those out before ranking).
 */
export function rankRelationshipCandidates(
  graph: Graph,
  person: PersonNode,
  choice: RelChoice,
  candidates: PersonNode[],
): RankedCandidates {
  const scores = new Map<string, number>()
  const hints = new Map<string, string>()
  const inCandidates = new Set(candidates.map((n) => n.nodeId))
  const nameOf = (id: string) =>
    graph.nodes.find((n) => n.nodeId === id)?.name ?? '?'

  const bump = (id: string, by: number, hint?: string) => {
    if (!inCandidates.has(id)) return
    scores.set(id, (scores.get(id) ?? 0) + by)
    if (hint && !hints.has(id)) hints.set(id, hint)
  }

  // 1. Relationship-specific strong signal.
  if (choice === 'child_of') {
    // Picking a parent for `person` → partners of their existing parents.
    for (const s of suggestOtherParents(graph, person.nodeId)) {
      bump(s.nodeId, 100, `partner of ${s.viaParentName}`)
    }
  } else if (choice === 'parent_of') {
    // Picking a child for `person` → children of `person`'s partners who aren't
    // already `person`'s children.
    const own = new Set(childrenOf(graph, person.nodeId))
    for (const partnerId of partnersOf(graph, person.nodeId)) {
      for (const kidId of childrenOf(graph, partnerId)) {
        if (kidId === person.nodeId || own.has(kidId)) continue
        bump(kidId, 100, `child of ${nameOf(partnerId)}`)
      }
    }
  } else {
    // partner_of: picking a partner → people who already co-parent a child with
    // `person`.
    for (const kidId of childrenOf(graph, person.nodeId)) {
      for (const coParentId of parentsOf(graph, kidId)) {
        if (coParentId === person.nodeId) continue
        bump(coParentId, 100, `parent of ${nameOf(kidId)}`)
      }
    }
  }

  // 2. Generic structural proximity: sharing relatives with `person` is a mild
  // signal they belong in the same corner of the tree.
  const mine = neighborsOf(graph, person.nodeId)
  if (mine.size > 0) {
    for (const c of candidates) {
      const shared = [...neighborsOf(graph, c.nodeId)].filter((id) =>
        mine.has(id),
      ).length
      if (shared > 0) bump(c.nodeId, Math.min(shared, 3) * 10)
    }
  }

  // 3. Surname affinity.
  const mySurname = surnameOf(person)
  if (mySurname) {
    for (const c of candidates) {
      if (surnameOf(c) === mySurname) {
        bump(c.nodeId, 5, hints.has(c.nodeId) ? undefined : 'same last name')
      }
    }
  }

  return partition(candidates, scores, hints)
}

// --- member → person similarity ----------------------------------------------

function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokensOf(s: string | null | undefined): string[] {
  if (!s) return []
  return normalize(s).split(' ').filter(Boolean)
}

// The identifying tokens for a member: their display name plus the local part of
// their email (people often sign up as first.last@…).
function memberTokens(member: Member): string[] {
  const emailLocal = member.email ? member.email.split('@')[0] : ''
  return [...tokensOf(member.name), ...tokensOf(emailLocal)]
}

// A light name-similarity score between a node and a member: exact token hits
// count most, shared prefixes (≥3 chars) count a little.
function similarity(nodeName: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const nodeTokens = tokensOf(nodeName)
  let score = 0
  for (const nt of nodeTokens) {
    for (const mt of tokens) {
      if (nt === mt) {
        score += 10
      } else if (
        nt.length >= 3 &&
        mt.length >= 3 &&
        (nt.startsWith(mt) || mt.startsWith(nt))
      ) {
        score += 4
      }
    }
  }
  return score
}

/**
 * Rank the people offered when linking `member` to someone in the tree, by how
 * well each node's name matches the member's name/email. `nodes` is expected to
 * already be the linkable set (unclaimed people plus the member's current one).
 */
export function rankLinkCandidates(
  member: Member,
  nodes: PersonNode[],
): RankedCandidates {
  const tokens = memberTokens(member)
  const scores = new Map<string, number>()
  const hints = new Map<string, string>()
  for (const n of nodes) {
    const s = similarity(n.name, tokens)
    if (s > 0) {
      scores.set(n.nodeId, s)
      hints.set(n.nodeId, 'name match')
    }
  }
  return partition(nodes, scores, hints)
}
