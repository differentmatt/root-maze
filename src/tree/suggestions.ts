import type { Graph } from '../api'

// When you give someone a parent, their existing parent's partner is very often
// the other parent — so if we can spot that pairing we suggest it as a one-tap
// add. Suggestions are never stored; they're derived from the current graph.
export interface ParentSuggestion {
  nodeId: string
  name: string
  // The already-known parent this suggestion is the partner of, for a hint like
  // "partner of Ada — likely other parent".
  viaParentName: string
  // The subtype of the via-parent's parent_child edge (biological, step,
  // adoptive, foster). Adding the suggested parent should mirror this rather
  // than defaulting to biological.
  subtype: string
}

// Likely "other parents" for a person: partners of the person's existing
// parents who aren't already a parent of that person. `excludeIds` drops anyone
// already connected/selected so we never suggest a redundant link.
export function suggestOtherParents(
  graph: Graph,
  personId: string,
  excludeIds: Set<string> = new Set(),
): ParentSuggestion[] {
  const nameOf = (id: string) =>
    graph.nodes.find((n) => n.nodeId === id)?.name ?? '?'

  // Keep the parent's edge subtype so a suggested "other parent" can mirror it
  // (a step-parent's partner is likely also a step-parent, etc.).
  const subtypeOfParent = new Map<string, string>()
  for (const e of graph.edges) {
    if (e.edgeKind === 'parent_child' && e.toPerson === personId) {
      subtypeOfParent.set(e.fromPerson, e.subtype)
    }
  }
  const parentSet = new Set(subtypeOfParent.keys())
  if (parentSet.size === 0) return []

  const partnersOf = (id: string) =>
    graph.edges
      .filter(
        (e) =>
          e.edgeKind === 'partner' &&
          (e.fromPerson === id || e.toPerson === id),
      )
      .map((e) => (e.fromPerson === id ? e.toPerson : e.fromPerson))

  const seen = new Set<string>()
  const out: ParentSuggestion[] = []
  for (const parentId of parentSet) {
    for (const partnerId of partnersOf(parentId)) {
      if (
        partnerId === personId ||
        parentSet.has(partnerId) || // already a parent
        excludeIds.has(partnerId) ||
        seen.has(partnerId) ||
        !graph.nodes.some((n) => n.nodeId === partnerId)
      ) {
        continue
      }
      seen.add(partnerId)
      out.push({
        nodeId: partnerId,
        name: nameOf(partnerId),
        viaParentName: nameOf(parentId),
        subtype: subtypeOfParent.get(parentId) ?? '',
      })
    }
  }
  return out
}
