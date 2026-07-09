import type { Graph } from '../api'

// Siblings are never stored — they're derived from shared parents (per the data
// model). Two people are full siblings when they share the exact same set of
// parents, and half siblings when their parents only partially overlap.
export interface InferredSibling {
  nodeId: string
  name: string
  half: boolean
}

export function inferSiblings(graph: Graph, personId: string): InferredSibling[] {
  const parentsOf = (id: string) =>
    graph.edges
      .filter((e) => e.edgeKind === 'parent_child' && e.toPerson === id)
      .map((e) => e.fromPerson)

  const mine = new Set(parentsOf(personId))
  if (mine.size === 0) return []

  const siblings: InferredSibling[] = []
  for (const n of graph.nodes) {
    if (n.nodeId === personId) continue
    const theirs = new Set(parentsOf(n.nodeId))
    const shares = [...theirs].some((p) => mine.has(p))
    if (!shares) continue
    const full =
      theirs.size === mine.size && [...mine].every((p) => theirs.has(p))
    siblings.push({ nodeId: n.nodeId, name: n.name, half: !full })
  }
  return siblings
}
